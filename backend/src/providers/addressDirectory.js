import { ADDRESS_LOOKUPS_COLLECTION } from "../config/constants.js";
import { getDb, isMongoConfigured } from "./mongo.js";
import { roundCoord } from "./cache.js";

// Read/write for `address_lookups` — which address text names which coordinate.
//
// Same two rules as cache.js, for the same reason:
//
// 1. This is an optimisation over "show nothing". Every function degrades to an
//    empty result if Mongo is unconfigured, unreachable or slow, and nothing here
//    ever throws — a directory outage must cost the homepage its cached cards,
//    not its render.
// 2. Keys are the ROUNDED coordinate, from cache.js's own roundCoord, so a row
//    here joins the counts in complaint_cache. A raw coordinate would key rows
//    that could never be matched to the counts they were stored for.
//
// Unlike the caches there is NO TTL index (see ADDRESS_LOOKUPS_COLLECTION in
// constants.js): the counts expire daily, the mapping must not.

/**
 * Awaits the memoized index build without letting it fail the caller.
 *
 * Called by every read and write below, not by a startup hook: src/index.js
 * never runs on Vercel, where api/index.js only builds the app and each request
 * is its own invocation. This collection previously got its indexes in
 * production only because /api/warm happened to build them on its way to doing
 * something else — a side effect, not a mechanism, and one that would have
 * silently stopped covering the collection the moment warming changed or moved.
 *
 * The unique {lat, lng} index is the one that matters most here: without it a
 * race between two first-lookups of the same address leaves two rows with the
 * counter split across them, and the homepage lists that address twice.
 *
 * One round trip per process, since the promise is memoized. Never throws.
 */
async function ready() {
  try {
    await ensureAddressLookupIndexes();
  } catch (err) {
    console.warn("[directory] index setup failed, continuing without it:", err.message);
  }
}

/** The exact-match key for one address row. One row per cache coordinate. */
export function lookupKey(lat, lng) {
  return { lat: roundCoord(lat), lng: roundCoord(lng) };
}

let indexPromise = null;

/**
 * Creates the lookup indexes. Idempotent, and memoized so it costs one round
 * trip per process rather than one per request — mirrors ensureCacheIndexes.
 */
export async function ensureAddressLookupIndexes() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const db = await getDb();
      if (!db) return false;
      await db.collection(ADDRESS_LOOKUPS_COLLECTION).createIndexes([
        {
          key: { lat: 1, lng: 1 },
          name: "coord",
          // Unique for the same reason complaint_cache's key is: two concurrent
          // first-lookups of one address must not leave two rows with the
          // counter split between them.
          unique: true,
        },
        // Serves mode=top. lastSeenAt breaks ties so a burst of one-off lookups
        // orders by recency rather than by insertion accident.
        { key: { lookups: -1, lastSeenAt: -1 }, name: "lookups_desc" },
        { key: { lastSeenAt: -1 }, name: "lastSeenAt_desc" },
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
export function resetAddressLookupIndexMemo() {
  indexPromise = null;
}

/**
 * Records that someone looked up an address.
 *
 * The counter is `$inc`, and the address text is `$setOnInsert`: a coordinate
 * keeps the FIRST text that named it. Two formattings of one building ("456 Park
 * Ave" vs "456 Park Avenue") round to the same key, and letting the later one
 * win would make the homepage's labels flicker between them for no gain.
 *
 * `curated` is only set on insert too, so warming an address someone had already
 * searched does not relabel their lookup as editorial.
 *
 * Never throws. A failed write costs one row in a directory, not a request.
 *
 * @returns {Promise<boolean>} whether the write landed
 */
export async function recordLookup(
  { address, borough, lat, lng, curated = false },
  { now } = {}
) {
  if (!isMongoConfigured()) return false;
  if (typeof address !== "string" || !address.trim()) return false;
  await ready();

  try {
    const db = await getDb();
    if (!db) return false;

    const key = lookupKey(lat, lng);
    const at = now ?? new Date();
    await db.collection(ADDRESS_LOOKUPS_COLLECTION).updateOne(
      key,
      {
        $inc: { lookups: 1 },
        $set: { lastSeenAt: at },
        $setOnInsert: {
          ...key,
          address: address.trim(),
          // null is stored as null rather than omitted: an absent field and a
          // borough we could not determine are the same state, and storing it
          // keeps the document shape stable.
          borough: borough ?? null,
          curated,
          firstSeenAt: at,
        },
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.warn("[directory] lookup write failed, continuing:", err.message);
    return false;
  }
}

/**
 * Marks an address as curated, creating the row if it is new.
 *
 * Separate from recordLookup because warming is not a lookup: it must not
 * inflate the popularity counter that mode=top sorts by. An address that real
 * visitors also searched keeps its count and simply gains the flag.
 */
export async function recordCurated({ address, borough, lat, lng }, { now } = {}) {
  if (!isMongoConfigured()) return false;
  if (typeof address !== "string" || !address.trim()) return false;
  await ready();

  try {
    const db = await getDb();
    if (!db) return false;

    const key = lookupKey(lat, lng);
    const at = now ?? new Date();
    await db.collection(ADDRESS_LOOKUPS_COLLECTION).updateOne(
      key,
      {
        $set: { curated: true },
        $setOnInsert: {
          ...key,
          address: address.trim(),
          borough: borough ?? null,
          // Zero, not one: nobody has looked this up. mode=top then ranks every
          // real lookup above every unvisited curated row for free.
          lookups: 0,
          firstSeenAt: at,
          lastSeenAt: at,
        },
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.warn("[directory] curated write failed, continuing:", err.message);
    return false;
  }
}

/** Shared read path. Returns [] on any failure, never throws. */
async function query(sort, limit) {
  if (!isMongoConfigured()) return [];
  await ready();
  try {
    const db = await getDb();
    if (!db) return [];
    return await db
      .collection(ADDRESS_LOOKUPS_COLLECTION)
      .find({}, { projection: { _id: 0 } })
      .sort(sort)
      .limit(limit)
      .toArray();
  } catch (err) {
    console.warn("[directory] read failed, treating as empty:", err.message);
    return [];
  }
}

/** Most-looked-up addresses first. */
export function topLookups(limit) {
  return query({ lookups: -1, lastSeenAt: -1 }, limit);
}

/** Most-recently-looked-up addresses first. */
export function recentLookups(limit) {
  return query({ lastSeenAt: -1 }, limit);
}

/**
 * A random sample of rows, for the hero card.
 *
 * `$sample` rather than a random skip: skip needs a count first, and its cost
 * grows with the offset it discards. Returns [] on any failure, never throws.
 */
export async function sampleLookups(limit) {
  if (!isMongoConfigured()) return [];
  await ready();
  try {
    const db = await getDb();
    if (!db) return [];
    return await db
      .collection(ADDRESS_LOOKUPS_COLLECTION)
      .aggregate([{ $sample: { size: limit } }, { $project: { _id: 0 } }])
      .toArray();
  } catch (err) {
    console.warn("[directory] sample failed, treating as empty:", err.message);
    return [];
  }
}
