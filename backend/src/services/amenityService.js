import {
  AMENITY_TIERS,
  AMENITY_MAX_METERS,
  AMENITY_ROUTE_CANDIDATES,
  NON_DISCRETE_AMENITY_BUCKETS,
  WALKABILITY_TYPE_TO_BUCKET,
} from "../config/constants.js";
import { loadAmenities } from "../providers/amenities/index.js";
import {
  readAmenityDistances,
  writeAmenityDistances,
  readWalkabilityPlaces,
  writeWalkabilityPlaces,
} from "../providers/cache.js";
import { computeWalkingDistances } from "../providers/googleRoutes.js";
import { searchNearbyPlaces } from "../providers/googlePlaces.js";
import { haversineMeters } from "../lib/geo.js";

/**
 * Corrects straight-line distances to real walking distances, one batched
 * Google Routes call for every bucket's candidates at once.
 *
 * Cache-first: a Routes call costs money and network time (unlike the free
 * grid lookup that finds these candidates), so a repeat view of the same
 * coordinate must not re-bill it. See providers/cache.js's
 * readAmenityDistances/writeAmenityDistances.
 *
 * @param {{lat:number, lng:number}} origin
 * @param {Record<string, Record<string, {meters:number, name:string|null, lat:number, lng:number}[]>>} candidatesByTierBucket
 * @returns {Promise<Record<string, Record<string, {meters:number, name:string|null}>>|null>}
 */
async function resolveWalkingDistances(origin, candidatesByTierBucket) {
  const cached = await readAmenityDistances(origin.lat, origin.lng);
  if (cached) return cached;

  // Flatten every bucket's candidates into one destination list — this is
  // what makes the Routes call ONE request rather than one per bucket.
  const destinations = [];
  const slots = []; // parallel to destinations: which {tier, bucket, name, routes} each one is
  for (const [tierName, buckets] of Object.entries(candidatesByTierBucket)) {
    for (const [bucket, candidates] of Object.entries(buckets)) {
      for (const candidate of candidates) {
        slots.push({ tierName, bucket, name: candidate.name, routes: candidate.routes });
        destinations.push({ lat: candidate.lat, lng: candidate.lng });
      }
    }
  }
  if (destinations.length === 0) return null;

  const walkingMeters = await computeWalkingDistances(origin, destinations);

  // Per bucket, keep whichever of its (up to AMENITY_ROUTE_CANDIDATES)
  // candidates came back with the shortest REAL distance — the
  // straight-line-nearest point is not always the walking-nearest one. A
  // candidate Google found no route for (null) is skipped, never treated as
  // "0m away".
  //
  // `routes` rides along with whichever candidate actually wins so a
  // Routes-corrected subway/bus metric still reports the CORRECT station's
  // routes, not the straight-line-nearest one's — only carried when the
  // winning candidate's own index set it (see spatialIndex.js), so a bucket
  // with no route concept (parks, bike, rail) never gets a `routes` key
  // written into this cache doc at all.
  const best = {};
  walkingMeters.forEach((meters, i) => {
    if (meters === null) return;
    const { tierName, bucket, name, routes } = slots[i];
    best[tierName] ??= {};
    const current = best[tierName][bucket];
    if (!current || meters < current.meters) {
      best[tierName][bucket] = {
        meters: Math.round(meters),
        name,
        ...(routes !== undefined ? { routes } : {}),
      };
    }
  });

  // Only cache a real answer. If Google failed outright (no key, network
  // down, timeout) every entry above is skipped and `best` stays empty —
  // caching THAT would lock the address into straight-line-only for a full
  // TTL over what is likely a transient failure, not a fact about the
  // address. A partial result (some buckets corrected, others not) is a
  // legitimate, stable answer and is cached as-is.
  if (Object.keys(best).length > 0) {
    await writeAmenityDistances(origin.lat, origin.lng, best);
  }
  return best;
}

/**
 * Distance-and-count metrics for every amenity bucket at one point.
 *
 * The straight-line grid lookup (spatialIndex.nearestN) always runs first —
 * it is microseconds and is what supplies `within`, and the fallback
 * distance/name for any bucket the Routes correction below doesn't cover.
 * Google is then asked, in one batched call, to correct the top
 * AMENITY_ROUTE_CANDIDATES straight-line candidates per bucket to a real
 * walking distance; a bucket keeps its straight-line answer whenever that
 * correction is unavailable (no API key, the call failed, or Google found no
 * walkable route to any of the candidates offered).
 *
 * @returns {Promise<Record<string, Record<string, {meters, within, name, routes?: string[]}>>|null>}
 *   tier -> bucket -> metric. `meters` is null past AMENITY_MAX_METERS. A
 *   tier is null if its dataset failed to load anywhere (Mongo and file both
 *   absent/invalid); the whole result is null only if EVERY dataset failed,
 *   so the caller can degrade to a two-category (complaints-only) report.
 *   `routes` is present only on the transit tier's subway/bus buckets (which
 *   subway/bus routes serve this stop) — rail and every parks/bike bucket
 *   have no route concept and never carry the key.
 */
export async function getAmenityMetrics(lat, lng) {
  const datasets = await loadAmenities();

  const candidatesByTierBucket = {};
  let anyTierAvailable = false;

  for (const [tierName, { dataset, buckets }] of Object.entries(AMENITY_TIERS)) {
    const indexed = datasets?.[dataset];
    if (!indexed) continue;
    anyTierAvailable = true;

    const perBucket = {};
    for (const bucket of buckets) {
      const index = indexed[bucket];
      perBucket[bucket] = index
        ? index.nearestN(lat, lng, AMENITY_ROUTE_CANDIDATES, AMENITY_MAX_METERS)
        : [];
    }
    candidatesByTierBucket[tierName] = perBucket;
  }

  if (!anyTierAvailable) return null;

  const corrected = await resolveWalkingDistances({ lat, lng }, candidatesByTierBucket);

  const result = {};
  for (const [tierName, { dataset, radiusMeters, buckets }] of Object.entries(AMENITY_TIERS)) {
    const indexed = datasets?.[dataset];
    if (!indexed) {
      result[tierName] = null;
      continue;
    }

    const metrics = {};
    for (const bucket of buckets) {
      const index = indexed[bucket];
      const candidates = candidatesByTierBucket[tierName][bucket];
      const straightLine = candidates[0] ?? null;
      const fix = corrected?.[tierName]?.[bucket];

      const metric = {
        meters: fix ? fix.meters : straightLine ? Math.round(straightLine.meters) : null,
        within: index ? index.countWithin(lat, lng, radiusMeters) : 0,
        name: fix ? fix.name : (straightLine?.name ?? null),
      };

      // Which subway/bus routes serve this stop — see CLAUDE.md's routes
      // contract-change note. Deliberately scoped to these two buckets only:
      // rail has no route-join source (out of scope), and parks/bike have no
      // route concept at all, so neither gets a `routes` key added here.
      if (bucket === "subway" || bucket === "bus") {
        metric.routes = (fix?.routes ?? straightLine?.routes) ?? [];
      }

      metrics[bucket] = metric;
    }
    result[tierName] = metrics;
  }

  return result;
}

/** First bucket whose type list intersects the place's `types`, in bucket order. */
function bucketForPlace(place, buckets) {
  for (const type of place.types) {
    const bucket = WALKABILITY_TYPE_TO_BUCKET[type];
    if (bucket && buckets.includes(bucket)) return bucket;
  }
  return null;
}

/**
 * Walkability's distance-and-count metrics, same shape as getAmenityMetrics()
 * returns per tier — but sourced live, from Google Places, rather than a
 * static index. Distances are straight-line (haversine), NOT Routes-corrected
 * like the other three tiers: adding a second billed call on top of Places
 * would double this tier's cost and latency for accuracy Places' own 800m
 * search radius already makes a minor correction over in a dense street grid.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {{cacheOnly?: boolean}} [options] `cacheOnly: true` (the homepage/
 *   showcase render path) never calls Places live — a cache miss there
 *   returns null (section omitted) rather than paying for a billed call on
 *   a path that must stay fast and free, same contract as getCounts().
 * @returns {Promise<Record<string, {meters:number|null, within:number, name:string|null}>|null>}
 *   null when nothing is known yet for this coordinate (a cache miss under
 *   cacheOnly, or Places returning nothing usable) — distinct from a genuine
 *   "searched and found nothing", which the caller degrades to an
 *   all-buckets-empty metrics object instead of omitting the section.
 */
export async function getWalkabilityMetrics(lat, lng, { cacheOnly = false } = {}) {
  const { radiusMeters, buckets } = AMENITY_TIERS.walkability;

  let places = await readWalkabilityPlaces(lat, lng);
  if (places === null) {
    if (cacheOnly) return null;
    places = await searchNearbyPlaces({ lat, lng }, radiusMeters, Object.keys(WALKABILITY_TYPE_TO_BUCKET));
    // Cached even when empty — searchNearbyPlaces never throws, so an empty
    // array here is either a genuine "nothing within range" or "no API key /
    // call failed", and both are worth NOT re-billing for 30 days. Contrast
    // with resolveWalkingDistances above, which deliberately does NOT cache
    // an empty Routes correction — that failure mode has a free fallback
    // (the straight-line distance) to keep re-trying for; this tier has none.
    await writeWalkabilityPlaces(lat, lng, places);
  }

  const metrics = {};
  for (const bucket of buckets) {
    metrics[bucket] = { meters: null, within: 0, name: null };
  }

  for (const place of places) {
    const bucket = bucketForPlace(place, buckets);
    if (!bucket) continue;
    const meters = Math.round(haversineMeters(lat, lng, place.lat, place.lng));
    if (meters > radiusMeters) continue; // defense in depth against a wider Places response
    metrics[bucket].within += 1;
    if (metrics[bucket].meters === null || meters < metrics[bucket].meters) {
      metrics[bucket].meters = meters;
      metrics[bucket].name = place.name;
    }
  }

  return metrics;
}

/**
 * Every real instance of one bucket within its tier's radius — what backs
 * an amenity row's `>` affordance (GET /api/amenities/nearby), as opposed to
 * just the single nearest one getAmenityMetrics() reports for scoring.
 *
 * Same dataset lookup getAmenityMetrics() uses — `datasets[tier.dataset]` —
 * just calling the index's allWithin() instead of nearestN()/countWithin().
 * Walkability has no `dataset` field (see AMENITY_TIERS), so `tierConfig
 * .dataset` is undefined for it and this returns null by the same
 * construction getAmenityMetrics()'s own loop already relies on — walkability
 * buckets are served by getNearbyWalkabilityInstances() below instead, since
 * their data comes from a live-then-cached Places call, not a preloaded
 * spatial index.
 *
 * @param {string} tierName one of AMENITY_TIERS' keys (transit/parks/bike)
 * @param {string} bucket must belong to that tier and not be one of
 *   NON_DISCRETE_AMENITY_BUCKETS (bikeLane/protectedLane — a resampled line,
 *   not discrete instances; see constants.js). The route checks this too,
 *   for a clearer 400 — this defends the function against any other caller.
 * @returns {Promise<{instances: object[], radiusMeters: number, truncated: boolean}|null>}
 *   null when the tier/bucket pair is invalid, excluded, or the tier's
 *   dataset failed to load — the route maps null to a 503, since an invalid
 *   tier/bucket is already rejected by validation before this is called.
 */
export async function getNearbyAmenityInstances(tierName, bucket, lat, lng, { limit } = {}) {
  const tierConfig = AMENITY_TIERS[tierName];
  if (!tierConfig?.dataset || !tierConfig.buckets.includes(bucket)) return null;
  if (NON_DISCRETE_AMENITY_BUCKETS.includes(bucket)) return null;

  const datasets = await loadAmenities();
  const index = datasets?.[tierConfig.dataset]?.[bucket];
  if (!index) return null;

  const radiusMeters = tierConfig.radiusMeters;
  // countWithin is O(cells in the square), not O(matches) — cheap enough to
  // run alongside allWithin purely to detect truncation, without allWithin
  // itself having to return an unbounded array just to know its own length
  // was capped.
  const total = index.countWithin(lat, lng, radiusMeters);
  const instances = index.allWithin(lat, lng, radiusMeters, limit ? { limit } : undefined);

  return { instances, radiusMeters, truncated: total > instances.length };
}

/**
 * The walkability analogue of getNearbyAmenityInstances() above, for the one
 * amenity tier with no preloaded spatial index.
 *
 * CACHE-ONLY, deliberately — reuses whatever Places result
 * getWalkabilityMetrics() already wrote for this coordinate
 * (readWalkabilityPlaces), rather than issuing a fresh billed Places call
 * just to populate a drill-down list. In practice this is warm by the time
 * anyone could click the `>` affordance: the affordance only renders on a
 * report that already has `walkabilityAccess`, which means /api/score
 * already ran getWalkabilityMetrics() for this exact coordinate and wrote
 * the cache entry this reads. A genuinely cold cache (a coordinate this was
 * called for directly, bypassing /api/score) answers "nothing yet" —
 * `instances: []` — rather than paying for a live call.
 *
 * @returns {Promise<{instances: object[], radiusMeters: number, truncated: boolean}|null>}
 *   null when `bucket` isn't one of walkability's four buckets. `truncated`
 *   is always false: Places' own `maxResultCount` (20) is already applied
 *   before the result is cached, and nothing here re-slices it further.
 */
export async function getNearbyWalkabilityInstances(bucket, lat, lng) {
  const { radiusMeters, buckets } = AMENITY_TIERS.walkability;
  if (!buckets.includes(bucket)) return null;

  const places = (await readWalkabilityPlaces(lat, lng)) ?? [];
  const instances = places
    .filter((place) => bucketForPlace(place, buckets) === bucket)
    .map((place) => ({
      meters: Math.round(haversineMeters(lat, lng, place.lat, place.lng)),
      name: place.name,
      lat: place.lat,
      lng: place.lng,
    }))
    .filter((instance) => instance.meters <= radiusMeters)
    .sort((a, b) => a.meters - b.meters);

  return { instances, radiusMeters, truncated: false };
}
