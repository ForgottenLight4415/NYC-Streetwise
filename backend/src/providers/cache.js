import {
  CACHE_COLLECTION,
  CACHE_COORD_PRECISION,
  CACHE_TTL_SECONDS,
  TREND_CACHE_COLLECTION,
  COMPLAINT_GROUPS_COLLECTION,
  BUCKET_NAMES,
  AMENITY_DISTANCE_CACHE_RADIUS_TIER,
  WALKABILITY_CACHE_COLLECTION,
  WALKABILITY_CACHE_PRECISION,
  WALKABILITY_CACHE_TTL_SECONDS,
} from "../config/constants.js";
import { getDb, isMongoConfigured } from "./mongo.js";

// Read/write for `complaint_cache`.
//
// Two rules shape this file:
//
// 1. A cache is an optimisation. Every function here degrades to "miss" if Mongo
//    is unconfigured, unreachable, or slow — a cache outage must never turn into
//    a 500 on the score endpoint mid-demo.
// 2. NO 2dsphere index. Spatial filtering is Socrata's job; the cache lookup is
//    an exact match on rounded coordinates (see CLAUDE.md).

/**
 * Awaits a memoized index build without letting it fail the caller.
 *
 * Every read and write below calls this first, rather than trusting a startup
 * hook. src/index.js was written for a long-running server with a boot phase;
 * Vercel has no boot phase — api/index.js only builds the app, and each request
 * is its own short-lived invocation — so in production that hook NEVER RUNS.
 * Relying on it meant the deployed database had no unique constraints and no TTL
 * at all: cached documents would have lived forever, and concurrent misses could
 * leave duplicate rows that reads flip between.
 *
 * Cost is one round trip per process, not per request: the ensure* functions
 * memoize their promise, so every later call awaits an already-resolved one.
 *
 * Never throws, in keeping with rule 1 above — an index that cannot be built is
 * a slower query, not a failed request.
 */
async function ready(ensure) {
  try {
    await ensure();
  } catch (err) {
    console.warn("[cache] index setup failed, continuing without it:", err.message);
  }
}

/** Rounds one coordinate to the cache-key precision (~11m at 4dp). */
export function roundCoord(value) {
  // Number(...toFixed) rather than Math.round(v*1e4)/1e4: the latter leaves
  // float dust (40.7484000000001) that would never match a stored key.
  return Number(value.toFixed(CACHE_COORD_PRECISION));
}

/** The exact-match key for one point at one radius tier. */
export function cacheKey(lat, lng, radiusTier) {
  return { lat: roundCoord(lat), lng: roundCoord(lng), radiusTier };
}

let indexPromise = null;

/**
 * Creates the compound lookup index and the TTL index. Idempotent, and
 * memoized so it costs one round trip per process rather than one per request.
 */
export async function ensureCacheIndexes() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const db = await getDb();
      if (!db) return false;
      const collection = db.collection(CACHE_COLLECTION);
      await collection.createIndexes([
        {
          key: { lat: 1, lng: 1, radiusTier: 1 },
          name: "coord_tier",
          // Unique so a race between two concurrent misses cannot leave two
          // documents for the same circle, with reads flipping between them.
          unique: true,
        },
        {
          key: { createdAt: 1 },
          name: "createdAt_ttl",
          expireAfterSeconds: CACHE_TTL_SECONDS,
        },
      ]);
      return true;
    })().catch((err) => {
      indexPromise = null;
      throw err;
    });
  }
  return indexPromise;
}

/** Test seam: forget the memoized index promise between in-memory servers. */
export function resetCacheIndexMemo() {
  indexPromise = null;
}

function isCompleteCounts(counts, radiusTier) {
  if (!counts || typeof counts !== "object") return false;
  // A partially-written document (schema change, interrupted write) would put a
  // missing bucket into the scoring mean as NaN. Treat it as a miss instead.
  return BUCKET_NAMES[radiusTier].every((bucket) =>
    Number.isFinite(counts[bucket])
  );
}

/**
 * Looks up several tiers for one point in a single query, returning the whole
 * cached entry — counts AND any explanation stored alongside them.
 *
 * One query, not two: the explanation lives on the same document as the counts
 * it describes, so reading them together costs nothing extra and guarantees
 * they cannot disagree.
 *
 * @returns {Promise<Record<string, {counts: object, bucketStatusCounts: object|null,
 *   explanation: string|null, explanationSource: string|null}|null>>} `null`
 *   for any tier not cached.
 */
export async function readEntries(lat, lng, radiusTiers) {
  const result = Object.fromEntries(radiusTiers.map((tier) => [tier, null]));
  if (!isMongoConfigured()) return result;
  await ready(ensureCacheIndexes);

  try {
    const db = await getDb();
    if (!db) return result;

    const keyLat = roundCoord(lat);
    const keyLng = roundCoord(lng);
    const docs = await db
      .collection(CACHE_COLLECTION)
      .find({ lat: keyLat, lng: keyLng, radiusTier: { $in: radiusTiers } })
      .toArray();

    for (const doc of docs) {
      if (isCompleteCounts(doc.counts, doc.radiusTier)) {
        result[doc.radiusTier] = {
          counts: doc.counts,
          // null (not zero-filled) on a document written before this field
          // existed — a real "nothing computed" rather than a claim that
          // every status bucket was actually zero.
          bucketStatusCounts: doc.bucketStatusCounts ?? null,
          explanation: doc.explanation ?? null,
          explanationSource: doc.explanationSource ?? null,
          // When these counts were last (re)written — see writeCounts' sliding
          // TTL. scoreService.js uses this to tell whether the cached overall
          // summary (a SEPARATE document, own TTL) was generated from THESE
          // counts or from an earlier version of them.
          createdAt: doc.createdAt ?? null,
        };
      }
    }
    return result;
  } catch (err) {
    console.warn("[cache] read failed, treating as miss:", err.message);
    return result;
  }
}

/**
 * Counts only, for callers that do not care about explanations.
 *
 * @returns {Promise<Record<string, object|null>>} counts per requested tier;
 *   `null` for any tier that was not cached.
 */
export async function readCounts(lat, lng, radiusTiers) {
  const entries = await readEntries(lat, lng, radiusTiers);
  return Object.fromEntries(
    Object.entries(entries).map(([tier, entry]) => [tier, entry?.counts ?? null])
  );
}

/**
 * Upserts one tier's counts. Refreshing `createdAt` on every write is what makes
 * the TTL a sliding 24h window rather than a hard expiry on first insert.
 *
 * `bucketStatusCounts` is a trailing optional option, same convention as
 * `now` beside it — omitted, the field is simply not written, rather than
 * being defaulted to a zero-filled object that would claim a breakdown was
 * computed when it wasn't (e.g. a caller that hasn't been updated to compute
 * it yet).
 *
 * Returns true if the write landed; false if it was skipped or failed. Callers
 * do not branch on this — a failed cache write must not fail the request.
 */
export async function writeCounts(
  lat,
  lng,
  radiusTier,
  counts,
  { now, bucketStatusCounts } = {}
) {
  if (!isMongoConfigured()) return false;
  await ready(ensureCacheIndexes);

  try {
    const db = await getDb();
    if (!db) return false;

    const key = cacheKey(lat, lng, radiusTier);
    await db.collection(CACHE_COLLECTION).replaceOne(
      key,
      // createdAt must be a BSON Date; a string is silently ignored by the TTL
      // monitor and the document would live forever.
      //
      // This REPLACES the document, so any cached explanation is dropped along
      // with the counts it described. That is correct: an explanation written
      // about last week's counts must not survive onto this week's.
      {
        ...key,
        counts,
        ...(bucketStatusCounts ? { bucketStatusCounts } : {}),
        createdAt: now ?? new Date(),
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.warn("[cache] write failed, continuing uncached:", err.message);
    return false;
  }
}

/**
 * Stores a generated explanation on the SAME document as the counts it
 * describes, so the pair shares one TTL and cannot drift apart.
 *
 * `updateOne`, not `replaceOne`: the counts are already there and must survive.
 * `upsert: false` deliberately — if the counts document has expired, there is
 * nothing for this explanation to belong to, and writing a bare explanation
 * would leave a document that `readEntries` rejects as incomplete anyway.
 *
 * Never throws. A failed explanation write costs a regeneration, not a request.
 *
 * @returns {Promise<boolean>} whether the write landed on an existing document
 */
export async function writeExplanation(lat, lng, radiusTier, explanation, source) {
  if (!isMongoConfigured()) return false;
  await ready(ensureCacheIndexes);

  try {
    const db = await getDb();
    if (!db) return false;

    const result = await db
      .collection(CACHE_COLLECTION)
      .updateOne(cacheKey(lat, lng, radiusTier), {
        // createdAt is untouched: refreshing it here would extend the TTL of
        // stale counts every time someone asked for an explanation.
        $set: {
          explanation,
          explanationSource: source,
          explanationAt: new Date(),
        },
      });
    return result.matchedCount > 0;
  } catch (err) {
    console.warn("[cache] explanation write failed:", err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Amenity explanation cache
// ---------------------------------------------------------------------------
//
// Amenity DATA is never cached (amenityService.js's getAmenityMetrics is a
// local lookup, cheaper than a cache round trip). The AI EXPLANATION for an
// amenity tier is a different cost entirely — a metered call against a
// rate-limited free-tier key (see CLAUDE.md's Gemini RPD note) — so it still
// needs caching, same as a complaint tier's explanation.
//
// Reuses this SAME collection and its indexes (one doc per {lat,lng,
// radiusTier}, same TTL), with radiusTier values "transit"/"parks"/"bike".
// Deliberately NOT routed through writeExplanation/readEntries above: those
// assume a `counts` document already exists to attach the explanation to
// (isCompleteCounts() indexes BUCKET_NAMES[radiusTier], which has no entry
// for an amenity tier and would throw). An amenity explanation document has
// no counts to begin with — the explanation IS the whole document — so this
// upserts directly rather than updating an existing one.

/**
 * @returns {Promise<{explanation: string, explanationSource: string, basedOn: Date|null}|null>}
 */
export async function readAmenityExplanation(lat, lng, radiusTier) {
  if (!isMongoConfigured()) return null;
  await ready(ensureCacheIndexes);

  try {
    const db = await getDb();
    if (!db) return null;
    const doc = await db.collection(CACHE_COLLECTION).findOne(cacheKey(lat, lng, radiusTier));
    if (!doc?.explanation) return null;
    return {
      explanation: doc.explanation,
      explanationSource: doc.explanationSource ?? null,
      // Only ever set on the "overall" summary doc — see the `basedOn` param
      // on writeAmenityExplanation below. `null` for every other radiusTier
      // that reuses this same function (transit/parks/bike had no use for it).
      basedOn: doc.basedOn ?? null,
    };
  } catch (err) {
    console.warn("[cache] amenity explanation read failed, treating as miss:", err.message);
    return null;
  }
}

/**
 * @param {{now?: Date, basedOn?: Date}} [options]
 *   `basedOn` is the whole-report summary's own freshness stamp — the
 *   timestamp of the complaint counts it was generated from, so a later
 *   caller can tell a stored summary apart from one written about counts that
 *   have since been refreshed (see scoreService.js's resolveCachedOverallSummary).
 *   Meaningless for the other radiusTier values (transit/parks/bike) this
 *   function also serves, which simply omit it.
 * @returns {Promise<boolean>} whether the write landed.
 */
export async function writeAmenityExplanation(
  lat,
  lng,
  radiusTier,
  explanation,
  source,
  { now, basedOn } = {}
) {
  if (!isMongoConfigured()) return false;
  await ready(ensureCacheIndexes);

  try {
    const db = await getDb();
    if (!db) return false;
    const key = cacheKey(lat, lng, radiusTier);
    await db.collection(CACHE_COLLECTION).replaceOne(
      key,
      {
        ...key,
        explanation,
        explanationSource: source,
        ...(basedOn ? { basedOn } : {}),
        createdAt: now ?? new Date(),
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.warn("[cache] amenity explanation write failed:", err.message);
    return false;
  }
}

// Real (Google-routed) walking distances per amenity bucket, cached for the
// opposite reason amenity DATA above is never cached: a Routes API call
// costs money and network time, so a repeat view of the same address — a
// page refresh, the AI explanation fetch landing right after, a compare page
// — must not re-bill it the way the free grid lookup never needed to worry
// about.
//
// One document per coordinate covers ALL THREE amenity tiers, keyed on
// AMENITY_DISTANCE_CACHE_RADIUS_TIER rather than a real tier name — Google is
// called once with every bucket's candidates batched into a single request
// (see providers/googleRoutes.js), so there is one correction to cache per
// coordinate, not one per tier.

/** @returns {Promise<Record<string, Record<string, number|null>>|null>} tier -> bucket -> corrected metres, or null on a miss. */
export async function readAmenityDistances(lat, lng) {
  if (!isMongoConfigured()) return null;
  await ready(ensureCacheIndexes);

  try {
    const db = await getDb();
    if (!db) return null;
    const doc = await db
      .collection(CACHE_COLLECTION)
      .findOne(cacheKey(lat, lng, AMENITY_DISTANCE_CACHE_RADIUS_TIER));
    return doc?.distances ?? null;
  } catch (err) {
    console.warn("[cache] amenity distance read failed, treating as miss:", err.message);
    return null;
  }
}

/** @returns {Promise<boolean>} whether the write landed. */
export async function writeAmenityDistances(lat, lng, distances, { now } = {}) {
  if (!isMongoConfigured()) return false;
  await ready(ensureCacheIndexes);

  try {
    const db = await getDb();
    if (!db) return false;
    const key = cacheKey(lat, lng, AMENITY_DISTANCE_CACHE_RADIUS_TIER);
    await db.collection(CACHE_COLLECTION).replaceOne(
      key,
      { ...key, distances, createdAt: now ?? new Date() },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.warn("[cache] amenity distance write failed:", err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Trend cache
// ---------------------------------------------------------------------------
//
// Separate collection, same degrade-to-miss contract as everything above.
// Worth caching specifically: the block-tier aggregation is the slowest call in
// the app — measured 13s cold on a dense block, against a 5s Socrata timeout
// with two retries. That is inside the retry budget but outside a serverless
// function's, so an uncached hit is the one that fails in production.

let trendIndexPromise = null;

export async function ensureTrendCacheIndexes() {
  if (!trendIndexPromise) {
    trendIndexPromise = (async () => {
      const db = await getDb();
      if (!db) return false;
      await db.collection(TREND_CACHE_COLLECTION).createIndexes([
        {
          key: { lat: 1, lng: 1, radiusTier: 1, months: 1 },
          name: "coord_tier_months",
          unique: true,
        },
        {
          key: { createdAt: 1 },
          name: "createdAt_ttl",
          expireAfterSeconds: CACHE_TTL_SECONDS,
        },
      ]);
      return true;
    })().catch((err) => {
      trendIndexPromise = null;
      throw err;
    });
  }
  return trendIndexPromise;
}

/** Test seam, mirroring resetCacheIndexMemo. */
export function resetTrendCacheIndexMemo() {
  trendIndexPromise = null;
}

/** The exact-match key for one point, tier and window. */
export function trendCacheKey(lat, lng, radiusTier, months) {
  return { lat: roundCoord(lat), lng: roundCoord(lng), radiusTier, months };
}

/**
 * @returns {Promise<Array<{month: string, count: number}>|null>} null on miss.
 */
export async function readTrend(lat, lng, radiusTier, months) {
  if (!isMongoConfigured()) return null;
  await ready(ensureTrendCacheIndexes);
  try {
    const db = await getDb();
    if (!db) return null;
    const doc = await db
      .collection(TREND_CACHE_COLLECTION)
      .findOne(trendCacheKey(lat, lng, radiusTier, months));
    // A stored series must have exactly one entry per month, or the chart would
    // silently compress its own time axis. A short doc is a schema change or an
    // interrupted write; treat it as a miss.
    if (!doc || !Array.isArray(doc.points) || doc.points.length !== months) return null;
    return doc.points;
  } catch (err) {
    console.warn("[cache] trend read failed, treating as miss:", err.message);
    return null;
  }
}

/** Never throws. A failed write costs one repeat query, not a request. */
export async function writeTrend(lat, lng, radiusTier, months, points, { now } = {}) {
  if (!isMongoConfigured()) return false;
  await ready(ensureTrendCacheIndexes);
  try {
    const db = await getDb();
    if (!db) return false;
    const key = trendCacheKey(lat, lng, radiusTier, months);
    await db
      .collection(TREND_CACHE_COLLECTION)
      .replaceOne(key, { ...key, points, createdAt: now ?? new Date() }, { upsert: true });
    return true;
  } catch (err) {
    console.warn("[cache] trend write failed, continuing uncached:", err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Grouped complaint cache (`complaint_groups_cache`)
// ---------------------------------------------------------------------------
//
// Separate collection again, and for the same reason as the trend cache:
// writeCounts() REPLACES the counts document.
//
// One entry holds the full 24-month grouped set for an address+tier, so every
// window, type filter, status filter and page is answered from it without
// touching Socrata. There is no `months` in the key — unlike the trend cache —
// because the rows are stored newest-day-first and every window is a prefix.

let groupsIndexPromise = null;

export async function ensureComplaintGroupsIndexes() {
  if (!groupsIndexPromise) {
    groupsIndexPromise = (async () => {
      const db = await getDb();
      if (!db) return false;
      await db.collection(COMPLAINT_GROUPS_COLLECTION).createIndexes([
        {
          key: { lat: 1, lng: 1, radiusTier: 1 },
          name: "coord_tier",
          unique: true,
        },
        {
          key: { createdAt: 1 },
          name: "createdAt_ttl",
          expireAfterSeconds: CACHE_TTL_SECONDS,
        },
      ]);
      return true;
    })().catch((err) => {
      groupsIndexPromise = null;
      throw err;
    });
  }
  return groupsIndexPromise;
}

/** Test seam, mirroring resetCacheIndexMemo. */
export function resetComplaintGroupsIndexMemo() {
  groupsIndexPromise = null;
}

/**
 * @returns {Promise<{groups: Array, truncated: boolean}|null>} null on miss.
 */
export async function readComplaintGroups(lat, lng, radiusTier) {
  if (!isMongoConfigured()) return null;
  await ready(ensureComplaintGroupsIndexes);
  try {
    const db = await getDb();
    if (!db) return null;
    const doc = await db
      .collection(COMPLAINT_GROUPS_COLLECTION)
      .findOne(cacheKey(lat, lng, radiusTier));
    if (!doc || !Array.isArray(doc.groups)) return null;
    return { groups: doc.groups, truncated: Boolean(doc.truncated) };
  } catch (err) {
    console.warn("[cache] groups read failed, treating as miss:", err.message);
    return null;
  }
}

/** Never throws. A failed write costs one repeat fill, not a request. */
export async function writeComplaintGroups(lat, lng, radiusTier, groups, truncated, { now } = {}) {
  if (!isMongoConfigured()) return false;
  await ready(ensureComplaintGroupsIndexes);
  try {
    const db = await getDb();
    if (!db) return false;
    const key = cacheKey(lat, lng, radiusTier);
    await db.collection(COMPLAINT_GROUPS_COLLECTION).replaceOne(
      key,
      { ...key, groups, truncated, createdAt: now ?? new Date() },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.warn("[cache] groups write failed, continuing uncached:", err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Walkability places cache (`walkability_cache`)
// ---------------------------------------------------------------------------
//
// A dedicated collection, not a slot in CACHE_COLLECTION, for one reason:
// this needs its OWN TTL. Mongo ties expireAfterSeconds to the collection's
// index, not to individual documents, so a 30-day shelf life for grocery
// stores and schools cannot share an index with 311 complaint counts that
// self-refresh every 24h.
//
// Also its own (coarser) coordinate rounding — see WALKABILITY_CACHE_PRECISION —
// since maximising the hit rate on a BILLED call matters here in a way it
// never did for the free grid lookups the rest of this file caches.

let walkabilityIndexPromise = null;

export async function ensureWalkabilityCacheIndexes() {
  if (!walkabilityIndexPromise) {
    walkabilityIndexPromise = (async () => {
      const db = await getDb();
      if (!db) return false;
      await db.collection(WALKABILITY_CACHE_COLLECTION).createIndexes([
        {
          key: { lat: 1, lng: 1 },
          name: "coord",
          unique: true,
        },
        {
          key: { createdAt: 1 },
          name: "createdAt_ttl",
          expireAfterSeconds: WALKABILITY_CACHE_TTL_SECONDS,
        },
      ]);
      return true;
    })().catch((err) => {
      walkabilityIndexPromise = null;
      throw err;
    });
  }
  return walkabilityIndexPromise;
}

/** Test seam, mirroring resetCacheIndexMemo. */
export function resetWalkabilityCacheIndexMemo() {
  walkabilityIndexPromise = null;
}

/** The exact-match key for one point, at walkability's own coarser precision. */
function walkabilityCacheKey(lat, lng) {
  const factor = 10 ** WALKABILITY_CACHE_PRECISION;
  return {
    lat: Math.round(lat * factor) / factor,
    lng: Math.round(lng * factor) / factor,
  };
}

/**
 * @returns {Promise<{lat:number,lng:number,types:string[],name:string|null}[]|null>}
 *   `null` on a miss — NOT the same as `[]`, which means "we asked Google and
 *   it genuinely found nothing here". A caller on a cache-only path (the
 *   homepage/showcase render) must be able to tell "unknown" from "known
 *   empty" and omit the section only for the former.
 */
export async function readWalkabilityPlaces(lat, lng) {
  if (!isMongoConfigured()) return null;
  await ready(ensureWalkabilityCacheIndexes);

  try {
    const db = await getDb();
    if (!db) return null;
    const doc = await db
      .collection(WALKABILITY_CACHE_COLLECTION)
      .findOne(walkabilityCacheKey(lat, lng));
    if (!doc || !Array.isArray(doc.places)) return null;
    return doc.places;
  } catch (err) {
    console.warn("[cache] walkability read failed, treating as miss:", err.message);
    return null;
  }
}

/** Never throws. A failed write costs one repeat (billed) lookup, not a request. */
export async function writeWalkabilityPlaces(lat, lng, places, { now } = {}) {
  if (!isMongoConfigured()) return false;
  await ready(ensureWalkabilityCacheIndexes);

  try {
    const db = await getDb();
    if (!db) return false;
    const key = walkabilityCacheKey(lat, lng);
    await db
      .collection(WALKABILITY_CACHE_COLLECTION)
      .replaceOne(key, { ...key, places, createdAt: now ?? new Date() }, { upsert: true });
    return true;
  } catch (err) {
    console.warn("[cache] walkability write failed, continuing uncached:", err.message);
    return false;
  }
}
