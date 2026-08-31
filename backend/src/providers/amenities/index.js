import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AMENITY_BUCKET_NAMES, AMENITIES_COLLECTION } from "../../config/constants.js";
import { getDb, isMongoConfigured } from "../mongo.js";
import { buildIndex } from "./spatialIndex.js";

// Loads every amenity dataset (transit/parks/bike), indexed and ready to
// query. Memoized per PROCESS — this is a few MB of points across the three
// files, and rebuilding the grid per request would dominate the request it
// exists to make free.
//
// Mongo first, committed file second — the SAME order and reasons as
// providers/baseline.js: Mongo lets a refresh (the bikeShare cron; see
// CLAUDE.md) ship without a redeploy, the committed file means a fresh clone
// with no Mongo still scores. UNLIKE the 311/baseline caches, there is NO
// TTL here: this is reference data, and expiring it would leave nothing to
// score against between manual rebuilds.

const FILE_PATHS = {
  transit: fileURLToPath(new URL("../../config/amenities/transit.json", import.meta.url)),
  parks: fileURLToPath(new URL("../../config/amenities/parks.json", import.meta.url)),
  bike: fileURLToPath(new URL("../../config/amenities/bike.json", import.meta.url)),
};

export const AMENITY_FILE_PATHS = FILE_PATHS;

/**
 * Loose geographic sanity range, deliberately WIDER than NYC_BOUNDS. Unlike
 * an address, an amenity point is legitimately allowed to sit just outside
 * the city line — the nearest LIRR station to a Queens address near the
 * Nassau border may itself be in Nassau County. This only exists to catch
 * genuine corruption (swapped lat/lng, a stray null island 0,0), not to
 * fence amenities to the five boroughs.
 */
const SANITY_BOUNDS = { minLat: 39, maxLat: 42, minLng: -75, maxLng: -72 };

function isValidBucket(bucket) {
  if (!bucket || !Array.isArray(bucket.pts) || !Array.isArray(bucket.names)) return false;
  if (bucket.pts.length % 3 !== 0) return false;
  if (bucket.pts.length / 3 !== bucket.n) return false;

  for (let i = 0; i < bucket.pts.length; i += 3) {
    const lat = bucket.pts[i];
    const lng = bucket.pts[i + 1];
    const nameIdx = bucket.pts[i + 2];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (lat < SANITY_BOUNDS.minLat || lat > SANITY_BOUNDS.maxLat) return false;
    if (lng < SANITY_BOUNDS.minLng || lng > SANITY_BOUNDS.maxLng) return false;
    if (nameIdx !== -1 && (nameIdx < 0 || nameIdx >= bucket.names.length)) return false;
  }

  // routeSets/routeIdx are OPTIONAL and additive — only the transit dataset's
  // subway/bus buckets carry them (see bikeShare.js's encodeBucket and
  // CLAUDE.md's routes contract-change note). A bucket with NEITHER field is
  // still valid: that is every bucket today except transit.subway/transit.bus.
  // Both must be present together, or this is a half-written document.
  const hasRouteSets = "routeSets" in bucket;
  const hasRouteIdx = "routeIdx" in bucket;
  if (hasRouteSets !== hasRouteIdx) return false;
  if (hasRouteSets) {
    if (!Array.isArray(bucket.routeSets) || !Array.isArray(bucket.routeIdx)) return false;
    if (bucket.routeIdx.length !== bucket.n) return false;
    for (const set of bucket.routeSets) {
      if (!Array.isArray(set) || !set.every((r) => typeof r === "string")) return false;
    }
    for (const idx of bucket.routeIdx) {
      if (idx !== -1 && !(Number.isInteger(idx) && idx >= 0 && idx < bucket.routeSets.length)) {
        return false;
      }
    }
  }

  // complexIds/complexIdIdx are OPTIONAL and additive, same shape/pairing
  // rule as routeSets/routeIdx above — only transit.subway carries them (see
  // bikeShare.js's encodeBucket and scripts/buildAmenities.js's
  // buildSubwayBucket).
  const hasComplexIds = "complexIds" in bucket;
  const hasComplexIdIdx = "complexIdIdx" in bucket;
  if (hasComplexIds !== hasComplexIdIdx) return false;
  if (hasComplexIds) {
    if (!Array.isArray(bucket.complexIds) || !Array.isArray(bucket.complexIdIdx)) return false;
    if (bucket.complexIdIdx.length !== bucket.n) return false;
    if (!bucket.complexIds.every((id) => typeof id === "string")) return false;
    for (const idx of bucket.complexIdIdx) {
      if (idx !== -1 && !(Number.isInteger(idx) && idx >= 0 && idx < bucket.complexIds.length)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * A dataset doc is only usable if it has EXACTLY the buckets AMENITY_TIERS
 * expects for it and every one is well-formed — a doc missing a bucket would
 * leave that bucket un-scoreable, the same hazard isValidBaseline guards
 * against for the complaint baseline. Dataset name and tier name are the
 * same string ("transit"/"parks"/"bike"), so this is a direct lookup.
 */
export function isValidDataset(name, doc) {
  if (!doc || typeof doc !== "object") return false;
  const expectedBuckets = AMENITY_BUCKET_NAMES[name];
  if (!expectedBuckets) return false;
  return (
    expectedBuckets.every((bucket) => isValidBucket(doc[bucket])) &&
    Object.keys(doc).length === expectedBuckets.length
  );
}

async function readFromMongo(name) {
  if (!isMongoConfigured()) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const raw = await db.collection(AMENITIES_COLLECTION).findOne({ _id: name });
    if (!raw) return null;
    // Strip _id BEFORE validating — isValidDataset's contract is "exactly the
    // expected buckets, nothing else", and every Mongo doc carries an _id
    // Mongo itself adds, not a bucket.
    const { _id, ...buckets } = raw;
    if (!isValidDataset(name, buckets)) {
      console.warn(`[amenities] mongo doc "${name}" is invalid, ignoring it`);
      return null;
    }
    return buckets;
  } catch (err) {
    console.warn(`[amenities] mongo read failed for "${name}":`, err.message);
    return null;
  }
}

async function readCommitted(name) {
  try {
    const doc = JSON.parse(await readFile(FILE_PATHS[name], "utf8"));
    if (!isValidDataset(name, doc)) {
      console.warn(`[amenities] committed ${name}.json is invalid`);
      return null;
    }
    return doc;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[amenities] committed ${name}.json unreadable:`, err.message);
    }
    return null;
  }
}

/** Builds a {bucketName: {nearest, countWithin}} map from a raw dataset doc. */
function indexDataset(doc) {
  const indexed = {};
  for (const [bucket, data] of Object.entries(doc)) {
    indexed[bucket] = buildIndex(data.pts, data.names, {
      routeSets: data.routeSets ?? null,
      routeIdx: data.routeIdx ?? null,
      complexIds: data.complexIds ?? null,
      complexIdIdx: data.complexIdIdx ?? null,
    });
  }
  return indexed;
}

let amenitiesPromise = null;

/**
 * All three amenity datasets, each bucket built into a spatial index.
 *
 * @returns {Promise<{transit: object, parks: object, bike: object}|null>}
 *   null only if EVERY source (Mongo and file) failed for a dataset — the
 *   caller (amenityService) degrades that tier's scores to absent rather than
 *   guessing.
 */
export async function loadAmenities({ forceRefresh = false } = {}) {
  if (forceRefresh) amenitiesPromise = null;

  if (!amenitiesPromise) {
    amenitiesPromise = (async () => {
      const result = {};
      for (const name of Object.keys(FILE_PATHS)) {
        const doc = (await readFromMongo(name)) ?? (await readCommitted(name));
        if (!doc) {
          console.warn(`[amenities] no usable "${name}" dataset found anywhere`);
          result[name] = null;
          continue;
        }
        result[name] = indexDataset(doc);
      }
      return result;
    })().catch((err) => {
      amenitiesPromise = null;
      throw err;
    });
  }

  return amenitiesPromise;
}

/**
 * The raw {bucket: {pts, names, n}} doc for one dataset — Mongo-then-file,
 * same order as loadAmenities(), but WITHOUT building a spatial index. For
 * a caller that needs to re-save a MODIFIED version of the current dataset
 * (the bikeShare-refresh cron route: fetch fresh bikeShare, keep the other
 * two "bike" buckets as they currently are) — a built index has no `pts`/
 * `names` to read back out and write again, only query methods.
 */
export async function loadRawAmenityDataset(name) {
  return (await readFromMongo(name)) ?? (await readCommitted(name));
}

/** Test seam / script seam: drop the memoized datasets. */
export function resetAmenitiesMemo() {
  amenitiesPromise = null;
}

/**
 * Upserts one amenity dataset document (e.g. "transit"). Used by
 * scripts/buildAmenities.js and the monthly bikeShare-refresh route — the
 * live request path never writes here.
 *
 * Runs the SAME sanity check buildAmenities.js's CLI guard does, so a caller
 * that skips the script (the cron route) cannot write a truncated dataset:
 * refuses if any bucket's point count falls more than 30% below the
 * currently-stored one. That comparison reads the CURRENT winning source
 * (Mongo-or-file) rather than assuming Mongo already has a copy, so the
 * first-ever write to a fresh Mongo still succeeds.
 *
 * @returns {Promise<boolean>} false when Mongo is absent, the write failed,
 *   or the guard refused it.
 */
export async function saveAmenityDataset(name, doc) {
  if (!isMongoConfigured()) return false;
  if (!isValidDataset(name, doc)) {
    console.warn(`[amenities] refusing to save "${name}": document failed validation`);
    return false;
  }

  try {
    const previous = (await readFromMongo(name)) ?? (await readCommitted(name));
    if (previous) {
      for (const [bucket, data] of Object.entries(doc)) {
        const before = previous[bucket]?.n ?? 0;
        if (before > 0 && data.n < before * 0.7) {
          console.warn(
            `[amenities] refusing to save "${name}": bucket "${bucket}" dropped from ` +
              `${before} to ${data.n} points (>30% drop) — looks like a truncated fetch.`
          );
          return false;
        }
      }
    }

    const db = await getDb();
    if (!db) return false;
    await db
      .collection(AMENITIES_COLLECTION)
      .replaceOne({ _id: name }, { _id: name, ...doc }, { upsert: true });
    return true;
  } catch (err) {
    console.warn(`[amenities] mongo write failed for "${name}":`, err.message);
    return false;
  }
}
