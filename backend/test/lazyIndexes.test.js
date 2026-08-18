import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startMongo } from "./helpers/mongoTestServer.js";
import {
  ensureCacheIndexes,
  ensureTrendCacheIndexes,
  ensureComplaintGroupsIndexes,
  resetCacheIndexMemo,
  resetTrendCacheIndexMemo,
  resetComplaintGroupsIndexMemo,
  readEntries,
  writeCounts,
  readTrend,
  writeTrend,
  readComplaintGroups,
  writeComplaintGroups,
} from "../src/providers/cache.js";
import {
  ensureAddressLookupIndexes,
  resetAddressLookupIndexMemo,
  recordLookup,
  topLookups,
} from "../src/providers/addressDirectory.js";
import { getDb } from "../src/providers/mongo.js";
import {
  CACHE_COLLECTION,
  TREND_CACHE_COLLECTION,
  COMPLAINT_GROUPS_COLLECTION,
  ADDRESS_LOOKUPS_COLLECTION,
  CACHE_TTL_SECONDS,
} from "../src/config/constants.js";

// Indexes must exist on FIRST REAL USE, not because a startup script ran.
//
// src/index.js assumes a long-running server with a boot phase. Vercel has no
// boot phase: api/index.js only builds the app, and every request is its own
// short-lived invocation, so that file never executes in production. Before this,
// three collections had no indexes there at all -- meaning no TTL (documents
// living forever) and no unique constraint (concurrent misses leaving duplicate
// rows). address_lookups was covered only by accident, because /api/warm built
// its indexes on the way to doing something else.
//
// Each case below drives a normal provider call against a database with NO
// indexes and no startup hook, then asserts the indexes are there. That is the
// production path, and it is what these tests exist to keep true.

const LAT = 40.7484;
const LNG = -73.9857;
const BUILDING = { heatHotWater: 12, unsanitaryCondition: 3, plumbing: 0 };
const BLOCK = { noise: 1653, parking: 402, streetCondition: 88 };

let mongo;

beforeAll(async () => {
  mongo = await startMongo();
});

afterAll(async () => {
  await mongo.stop();
});

/** A database as empty as a fresh Atlas cluster, with every memo forgotten. */
async function coldDatabase() {
  const db = await getDb();
  for (const name of [
    CACHE_COLLECTION,
    TREND_CACHE_COLLECTION,
    COMPLAINT_GROUPS_COLLECTION,
    ADDRESS_LOOKUPS_COLLECTION,
  ]) {
    await db.collection(name).drop().catch(() => {});
  }
  resetCacheIndexMemo();
  resetTrendCacheIndexMemo();
  resetComplaintGroupsIndexMemo();
  resetAddressLookupIndexMemo();
}

async function indexNames(collection) {
  const db = await getDb();
  const indexes = await db.collection(collection).indexes().catch(() => []);
  return indexes.map((i) => i.name);
}

beforeEach(coldDatabase);

describe("indexes are built by first use, not by a startup hook", () => {
  it("complaint_cache — a write builds them", async () => {
    await writeCounts(LAT, LNG, "building", BUILDING);
    expect(await indexNames(CACHE_COLLECTION)).toEqual(
      expect.arrayContaining(["coord_tier", "createdAt_ttl"])
    );
  });

  it("complaint_cache — a read builds them too", async () => {
    // A deploy that only ever served cache misses would otherwise never index.
    await readEntries(LAT, LNG, ["building", "block"]);
    expect(await indexNames(CACHE_COLLECTION)).toEqual(
      expect.arrayContaining(["coord_tier", "createdAt_ttl"])
    );
  });

  it("trend_cache — a write builds them", async () => {
    await writeTrend(LAT, LNG, "block", 1, [{ month: "2026-08", count: 3 }]);
    expect(await indexNames(TREND_CACHE_COLLECTION)).toEqual(
      expect.arrayContaining(["coord_tier_months", "createdAt_ttl"])
    );
  });

  it("trend_cache — a read builds them", async () => {
    await readTrend(LAT, LNG, "block", 9);
    expect(await indexNames(TREND_CACHE_COLLECTION)).toEqual(
      expect.arrayContaining(["coord_tier_months", "createdAt_ttl"])
    );
  });

  it("complaint_groups_cache — a write builds them", async () => {
    await writeComplaintGroups(LAT, LNG, "block", [], false);
    expect(await indexNames(COMPLAINT_GROUPS_COLLECTION)).toEqual(
      expect.arrayContaining(["coord_tier", "createdAt_ttl"])
    );
  });

  it("complaint_groups_cache — a read builds them", async () => {
    await readComplaintGroups(LAT, LNG, "block");
    expect(await indexNames(COMPLAINT_GROUPS_COLLECTION)).toEqual(
      expect.arrayContaining(["coord_tier", "createdAt_ttl"])
    );
  });

  it("address_lookups — a write builds them, with no help from /api/warm", async () => {
    // The regression this guards: warming used to be the only thing that built
    // these in production, which made an unrelated endpoint load-bearing.
    await recordLookup({
      address: "456 Park Ave, New York, NY 10022",
      borough: "Manhattan",
      lat: 40.7614,
      lng: -73.9707,
    });
    expect(await indexNames(ADDRESS_LOOKUPS_COLLECTION)).toEqual(
      expect.arrayContaining(["coord", "lookups_desc", "lastSeenAt_desc"])
    );
  });

  it("address_lookups — a read builds them", async () => {
    await topLookups(4);
    expect(await indexNames(ADDRESS_LOOKUPS_COLLECTION)).toEqual(
      expect.arrayContaining(["coord", "lookups_desc", "lastSeenAt_desc"])
    );
  });

  it("every TTL index really carries an expiry, so nothing lives forever", async () => {
    await writeCounts(LAT, LNG, "building", BUILDING);
    await writeTrend(LAT, LNG, "block", 1, [{ month: "2026-08", count: 3 }]);
    await writeComplaintGroups(LAT, LNG, "block", [], false);

    const db = await getDb();
    for (const name of [
      CACHE_COLLECTION,
      TREND_CACHE_COLLECTION,
      COMPLAINT_GROUPS_COLLECTION,
    ]) {
      const ttl = (await db.collection(name).indexes()).find(
        (i) => i.name === "createdAt_ttl"
      );
      expect(ttl?.expireAfterSeconds).toBe(CACHE_TTL_SECONDS);
    }

    // The directory is the deliberate exception — see ADDRESS_LOOKUPS_COLLECTION.
    await recordLookup({ address: "1 Test St, Brooklyn, NY 11249", lat: 40.7178, lng: -73.9647 });
    const directory = await db.collection(ADDRESS_LOOKUPS_COLLECTION).indexes();
    expect(directory.some((i) => i.expireAfterSeconds !== undefined)).toBe(false);
  });
});

describe("memoization — one round trip per process, not per request", () => {
  const cases = [
    ["complaint_cache", CACHE_COLLECTION, ensureCacheIndexes],
    ["trend_cache", TREND_CACHE_COLLECTION, ensureTrendCacheIndexes],
    ["complaint_groups_cache", COMPLAINT_GROUPS_COLLECTION, ensureComplaintGroupsIndexes],
    ["address_lookups", ADDRESS_LOOKUPS_COLLECTION, ensureAddressLookupIndexes],
  ];

  for (const [label, collection, ensure] of cases) {
    it(`${label} — a second call issues no further createIndexes`, async () => {
      // Build once so the memo is populated, then watch a fresh handle: any
      // further call reaching the driver would mean the memo is not holding.
      await ensure();
      const db = await getDb();
      const spy = vi.spyOn(db.collection(collection), "createIndexes");

      await ensure();
      await ensure();

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it(`${label} — concurrent callers share one build`, async () => {
      const db = await getDb();
      const spy = vi.spyOn(db.collection(collection), "createIndexes");

      await Promise.all([ensure(), ensure(), ensure()]);

      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
      spy.mockRestore();
    });
  }

  it("repeated provider calls do not re-issue index creation", async () => {
    // The cost question the lazy pattern raises: does putting ensure*() on every
    // read make every read pay for it? It must not.
    await writeCounts(LAT, LNG, "block", BLOCK);
    const db = await getDb();
    const spy = vi.spyOn(db.collection(CACHE_COLLECTION), "createIndexes");

    await readEntries(LAT, LNG, ["building", "block"]);
    await readEntries(LAT, LNG, ["building", "block"]);
    await writeCounts(LAT, LNG, "building", BUILDING);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a failed build is retried rather than memoized as broken", async () => {
    resetCacheIndexMemo();
    const db = await getDb();
    const spy = vi
      .spyOn(db.collection(CACHE_COLLECTION), "createIndexes")
      .mockRejectedValueOnce(new Error("transient atlas failure"));

    // The provider swallows it — a missing index is a slower query, not a 500.
    await expect(writeCounts(LAT, LNG, "building", BUILDING)).resolves.toBe(true);
    spy.mockRestore();

    // ...and the next call tries again, instead of holding the rejection forever.
    await writeCounts(LAT, LNG, "block", BLOCK);
    expect(await indexNames(CACHE_COLLECTION)).toEqual(
      expect.arrayContaining(["coord_tier", "createdAt_ttl"])
    );
  });
});
