import {
  AMENITY_TIERS,
  AMENITY_MAX_METERS,
  AMENITY_ROUTE_CANDIDATES,
  AMENITY_SUBWAY_COMPLEX_CAP,
  AMENITY_BUS_STOP_CAP,
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
 * @param {{retries?: number}} [options] Forwarded to computeWalkingDistances —
 *   see its docstring for why this defaults to 0 (fail-fast) on the request
 *   path but buildAmenityBaseline.js overrides it.
 * @returns {Promise<Record<string, Record<string, {meters:number, name:string|null}>>|null>}
 */
async function resolveWalkingDistances(origin, candidatesByTierBucket, { retries } = {}) {
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

  const walkingMeters = await computeWalkingDistances(origin, destinations, { retries });

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
 * @param {{routeRetries?: number}} [options] `routeRetries` is forwarded to
 *   computeWalkingDistances, which defaults to 0 (fail-fast, never delays
 *   the request path — see its docstring). buildAmenityBaseline.js overrides
 *   this to a positive number: that script's baseline is a citywide
 *   reference for the SAME route-corrected distances live scoring measures
 *   (see CLAUDE.md's amenity scores section), so it must use the same
 *   measurement, not a cheaper straight-line stand-in — a baseline built
 *   from smaller straight-line numbers would systematically understate every
 *   live, route-corrected score compared against it. Bounded retry-with-
 *   backoff on 429 (same pattern as providers/socrata.js's `query()`) is
 *   what makes ~150 sequential live Routes calls survive Google's per-second
 *   quota instead of degrading unpredictably mid-run.
 * @returns {Promise<Record<string, Record<string, {meters, within, name, routes?: string[]}>>|null>}
 *   tier -> bucket -> metric. `meters` is null past AMENITY_MAX_METERS. A
 *   tier is null if its dataset failed to load anywhere (Mongo and file both
 *   absent/invalid); the whole result is null only if EVERY dataset failed,
 *   so the caller can degrade to a two-category (complaints-only) report.
 *   `routes` is present only on the transit tier's subway/bus buckets (which
 *   subway/bus routes serve this stop) — rail and every parks/bike bucket
 *   have no route concept and never carry the key.
 */
export async function getAmenityMetrics(lat, lng, { routeRetries } = {}) {
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

  const corrected = await resolveWalkingDistances({ lat, lng }, candidatesByTierBucket, {
    retries: routeRetries,
  });

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

// Raw entrance pool fetched before subway grouping/dedup collapses them to
// AMENITY_SUBWAY_COMPLEX_CAP complexes — generous on purpose. A dense hub
// like Herald Sq alone has 15 entrances; this pool needs to hold every
// entrance across however many DISTINCT complexes fall within radius before
// grouping can even see them all, not just the default 50-raw-point cap
// allWithin() uses for every other bucket.
const SUBWAY_ENTRANCE_POOL_LIMIT = 200;

/**
 * Folds raw entrance-level matches (one per physical door, each tagged with
 * the `complexId` baked in at build time — see scripts/buildAmenities.js's
 * buildSubwayBucket) into one result per station complex, positioned at
 * whichever of its entrances is nearest, then applies the same-line dedup
 * rule and caps to AMENITY_SUBWAY_COMPLEX_CAP.
 *
 * Same-line dedup: after sorting complexes by distance, a farther complex
 * whose ENTIRE route set is already covered by closer, already-kept
 * complexes is dropped — it adds no line a renter could not already reach
 * on a shorter walk. Coverage accumulates across every kept complex, not
 * just the nearest one, so a complex is only dropped once all its lines are
 * already reachable closer. A complex with no route data at all (routes:
 * []) is never dropped by this rule — there's nothing to compare, so it's
 * always kept rather than guessed at.
 *
 * Every member entrance's own distance is kept too, on `entrances` — not
 * shown as separate rows (that's the density problem this whole grouping
 * exists to solve), but the frontend's "[N entrances]" tag hovers to reveal
 * them. `instances` arrives nearest-first overall, so appending to a group
 * in that same order — rather than only on a new minimum — leaves each
 * group's own `entrances` naturally ascending too, no second sort needed.
 *
 * @param {{meters:number, name:string|null, lat:number, lng:number, routes?:string[], complexId?:string|null}[]} instances
 * @returns {{complexes: object[], totalComplexes: number}} `totalComplexes`
 *   is the count BEFORE the cap (but after dedup), for the caller's
 *   `truncated` flag.
 */
function groupSubwayComplexes(instances) {
  // Two indexes into the SAME group objects — by complexId and by name. An
  // entrance with no reliable complexId (buildSubwayBucket's geographic
  // outlier guard sets it to null) still needs to land in the SAME group as
  // the real complex it belongs to, not a second, disconnected one — it and
  // that complex's other entrances share an identical name, so matching by
  // name is exactly the fallback that reunites them.
  //
  // The name fallback must NOT fire for an entrance that already has its
  // OWN valid complexId, even when that id hasn't been seen yet — two
  // genuinely different official complexes can share a display name (34
  // St-Penn Station's 1/2/3 side and its separate A/C/E side are two
  // different complex_ids). So a name match is only trusted when the
  // candidate group hasn't already been claimed by a DIFFERENT real
  // complexId — `group.complexId` tracks whichever one first claimed it
  // (null while the group is still outlier-only), stripped from the
  // returned shape at the end.
  const groupsById = new Map();
  const groupsByName = new Map();
  const ordered = [];

  for (const inst of instances) {
    let group = inst.complexId ? groupsById.get(inst.complexId) : undefined;

    if (!group && inst.name) {
      const candidate = groupsByName.get(inst.name);
      if (candidate && (candidate.complexId == null || candidate.complexId === inst.complexId)) {
        group = candidate;
      }
    }

    if (!group) {
      // `instances` is nearest-first, so the first occurrence of a given
      // complex/name is necessarily its own nearest entrance — safe to seed
      // the group's representative name/meters/lat/lng/routes from it
      // directly.
      group = {
        name: inst.name,
        meters: inst.meters,
        lat: inst.lat,
        lng: inst.lng,
        routes: inst.routes ?? [],
        entrances: [],
        complexId: inst.complexId ?? null,
      };
      ordered.push(group);
    } else if (group.complexId == null && inst.complexId) {
      // The group was seeded by an outlier (no complexId of its own yet) —
      // a real complexId showing up for the same name claims it, so a
      // THIRD entrance can now also find it directly by that id.
      group.complexId = inst.complexId;
    }

    if (inst.complexId) groupsById.set(inst.complexId, group);
    if (inst.name) groupsByName.set(inst.name, group);
    group.entrances.push(inst.meters);
  }

  const sorted = ordered.sort((a, b) => a.meters - b.meters);

  const covered = new Set();
  const deduped = [];
  for (const group of sorted) {
    if (deduped.length > 0 && group.routes.length > 0) {
      const addsNothing = group.routes.every((route) => covered.has(route));
      if (addsNothing) continue;
    }
    for (const route of group.routes) covered.add(route);
    deduped.push(group);
  }

  // `complexId` above is internal bookkeeping for the merge logic, not part
  // of the documented response shape — strip it before handing groups back.
  const complexes = deduped
    .slice(0, AMENITY_SUBWAY_COMPLEX_CAP)
    .map(({ complexId, ...group }) => group);

  return { complexes, totalComplexes: deduped.length };
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
 * `subway` and `bus` get bucket-specific post-processing before the result
 * goes out — everything else (rail, parks, bike) is untouched, since neither
 * has the "one place, many raw points" density problem these two solve:
 * - `subway`: grouped into complexes, same-line-deduped, capped to
 *   AMENITY_SUBWAY_COMPLEX_CAP — see groupSubwayComplexes above.
 * - `bus`: already one point per physical pole from build-time clustering
 *   (buildAmenities.js's buildBusBucket), so this just caps to
 *   AMENITY_BUS_STOP_CAP, closest first.
 * Neither changes the response TYPE beyond one additive field — a grouped/
 * capped instance is still `{name, meters, lat, lng, routes}`, the same
 * shape as any other bucket's instance, just one per complex/pole instead of
 * one per raw point; `subway` instances also carry `entrances: number[]`,
 * every member entrance's own distance ascending, for the frontend's
 * "[N entrances]" hover breakdown (see groupSubwayComplexes above).
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
  const rawLimit = bucket === "subway" ? Math.max(limit ?? 0, SUBWAY_ENTRANCE_POOL_LIMIT) : limit;
  // countWithin is O(cells in the square), not O(matches) — cheap enough to
  // run alongside allWithin purely to detect truncation, without allWithin
  // itself having to return an unbounded array just to know its own length
  // was capped. Unused for subway/bus below, which compute their own
  // post-grouping/capping truncation flag instead.
  const total = index.countWithin(lat, lng, radiusMeters);
  const rawInstances = index.allWithin(lat, lng, radiusMeters, rawLimit ? { limit: rawLimit } : undefined);

  if (bucket === "subway") {
    const { complexes, totalComplexes } = groupSubwayComplexes(rawInstances);
    return { instances: complexes, radiusMeters, truncated: totalComplexes > complexes.length };
  }

  if (bucket === "bus") {
    // `total` (countWithin) already counts POLES, not raw GTFS stop records —
    // the index itself was built from build-time-clustered points, so this
    // is the exact distinct-pole count within radius, not an approximation
    // capped at allWithin's own 50-point default.
    const stops = rawInstances.slice(0, AMENITY_BUS_STOP_CAP);
    return { instances: stops, radiusMeters, truncated: total > stops.length };
  }

  return { instances: rawInstances, radiusMeters, truncated: total > rawInstances.length };
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
