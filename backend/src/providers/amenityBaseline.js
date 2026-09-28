import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AMENITY_BASELINE_COLLECTION,
  AMENITY_BASELINE_ID,
  AMENITY_BUCKET_NAMES,
  AMENITY_TIERS,
} from "../config/constants.js";
import { getDb, isMongoConfigured } from "./mongo.js";

// Amenity-scores analogue of providers/baseline.js — same Mongo-then-file
// order and same reasons. Kept as a SEPARATE file/collection rather than
// generalising baseline.js to cover both: merging would put amenity buckets
// into isValidBaseline's ALL_BUCKETS and instantly invalidate the committed
// complaint baseline.json (and fail test/baseline.test.js).

const COMMITTED_PATH = fileURLToPath(
  new URL("../config/amenityBaseline.json", import.meta.url)
);

/**
 * Every bucket across every SAMPLED amenity tier — the ones with a static
 * `dataset` behind them, which is what scripts/buildAmenityBaseline.js
 * covers and what this committed file holds.
 *
 * Deliberately NOT `Object.values(AMENITY_BUCKET_NAMES).flat()` any more:
 * that includes walkability's buckets too, and walkability has no static
 * dataset to sample — see AMENITY_TIERS.walkability's comment. Its baseline
 * is reasoned rather than sampled (WALKABILITY_BASELINE_PER_BUCKET in
 * constants.js) and merged in separately at the scoreService.js layer, never
 * written to this file. Including it here would mean this file can NEVER
 * validate as complete again, which is exactly the "instantly invalidate the
 * committed baseline" hazard the comment above already warns about for the
 * complaint baseline.
 */
const ALL_AMENITY_BUCKETS = Object.entries(AMENITY_TIERS)
  .filter(([, def]) => def.dataset)
  .flatMap(([tier]) => AMENITY_BUCKET_NAMES[tier]);

/**
 * A baseline missing a bucket would score that bucket against `undefined` and
 * quietly hand out a free 100 — the same hazard isValidBaseline guards
 * against for the complaint baseline.
 */
export function isValidAmenityBaseline(doc) {
  if (!doc || typeof doc !== "object" || !doc.perBucket) return false;
  return ALL_AMENITY_BUCKETS.every((bucket) => {
    const entry = doc.perBucket[bucket];
    return (
      entry &&
      Number.isFinite(entry.median) &&
      Number.isFinite(entry.p90) &&
      entry.median >= 0 &&
      entry.p90 >= 0
    );
  });
}

async function readFromMongo() {
  if (!isMongoConfigured()) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const doc = await db
      .collection(AMENITY_BASELINE_COLLECTION)
      .findOne({ _id: AMENITY_BASELINE_ID });
    if (!isValidAmenityBaseline(doc)) {
      if (doc) console.warn("[amenityBaseline] mongo doc is incomplete, ignoring it");
      return null;
    }
    return { ...doc, source: "mongo" };
  } catch (err) {
    console.warn("[amenityBaseline] mongo read failed:", err.message);
    return null;
  }
}

async function readCommitted() {
  try {
    const doc = JSON.parse(await readFile(COMMITTED_PATH, "utf8"));
    if (!isValidAmenityBaseline(doc)) {
      console.warn("[amenityBaseline] committed amenityBaseline.json is incomplete");
      return null;
    }
    return { ...doc, source: "file" };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[amenityBaseline] committed baseline unreadable:", err.message);
    }
    return null;
  }
}

let amenityBaselinePromise = null;

/**
 * The amenity baseline, memoized for the process lifetime — it changes only
 * when scripts/buildAmenityBaseline.js is rerun.
 *
 * @returns {Promise<object|null>} null when no baseline exists anywhere,
 *   which the amenity scorer surfaces as confidence "low" / reason
 *   "no_baseline", same as the complaint scorer does.
 */
export async function loadAmenityBaseline({ forceRefresh = false } = {}) {
  if (forceRefresh) amenityBaselinePromise = null;

  if (!amenityBaselinePromise) {
    amenityBaselinePromise = (async () => {
      const doc = (await readFromMongo()) ?? (await readCommitted());
      if (!doc) {
        console.warn(
          "[amenityBaseline] none found — amenity scores will be marked " +
            "low-confidence. Run `npm run baseline:amenities`."
        );
      }
      return doc;
    })().catch((err) => {
      amenityBaselinePromise = null;
      throw err;
    });
  }

  return amenityBaselinePromise;
}

/** Test seam / script seam: drop the memoized baseline. */
export function resetAmenityBaselineMemo() {
  amenityBaselinePromise = null;
}

/**
 * Upserts the amenity baseline document. Used only by
 * scripts/buildAmenityBaseline.js — the request path never writes here.
 *
 * @returns {Promise<boolean>} false when Mongo is absent or the write failed;
 *   the script still writes the committed JSON copy in that case.
 */
export async function saveAmenityBaseline(doc) {
  if (!isMongoConfigured()) return false;
  try {
    const db = await getDb();
    if (!db) return false;
    const { _id, ...rest } = doc;
    await db
      .collection(AMENITY_BASELINE_COLLECTION)
      .replaceOne({ _id: _id ?? AMENITY_BASELINE_ID }, { ...rest }, { upsert: true });
    return true;
  } catch (err) {
    console.warn("[amenityBaseline] mongo write failed:", err.message);
    return false;
  }
}

export { COMMITTED_PATH as AMENITY_BASELINE_FILE_PATH };
