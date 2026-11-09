import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { startMongo } from "./helpers/mongoTestServer.js";
import {
  roundCoord,
  cacheKey,
  ensureCacheIndexes,
  readCounts,
  readEntries,
  writeCounts,
  writeExplanation,
  readAmenityDistances,
  writeAmenityDistances,
  readComplaintGroups,
  writeComplaintGroups,
  ensureComplaintGroupsIndexes,
  ensureAmenityDistanceCacheIndexes,
  readTrend,
  writeTrend,
  typeSignature,
} from "../src/providers/cache.js";
import { getDb, isMongoConfigured, closeMongo } from "../src/providers/mongo.js";
import {
  CACHE_COLLECTION,
  CACHE_TTL_SECONDS,
  COMPLAINT_GROUPS_COLLECTION,
  TREND_CACHE_COLLECTION,
  AMENITY_DISTANCE_CACHE_COLLECTION,
  AMENITY_DISTANCE_CACHE_TTL_SECONDS,
} from "../src/config/constants.js";

const BUILDING = { heatHotWater: 12, unsanitaryCondition: 3, plumbing: 0, repairs: 0, electricGas: 0, buildingSafety: 0 };
const BLOCK = { noise: 1653, parking: 402, streetCondition: 88, sanitation: 0, infrastructure: 0, publicSafety: 0 };

let mongo;

beforeAll(async () => {
  mongo = await startMongo();
});

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(CACHE_COLLECTION).deleteMany({});
  // Amenity walking distances moved out of CACHE_COLLECTION into their own
  // collection (so they can carry their own, much longer TTL), so clearing
  // complaint_cache alone no longer isolates these tests from each other.
  await db.collection(AMENITY_DISTANCE_CACHE_COLLECTION).deleteMany({});
});

describe("key derivation (pure)", () => {
  // roundCoord rounds to 4 decimal places without floating-point dust (40.7484, not 40.748400000000004).
  it("rounds to 4dp without float dust", () => {
    expect(roundCoord(40.74841234)).toBe(40.7484);
    expect(roundCoord(-73.98567)).toBe(-73.9857);
    // Math.round(v * 1e4) / 1e4 leaves values like 40.748400000000004, which
    // would never match a stored key on an exact-match lookup.
    expect(String(roundCoord(40.7484))).toBe("40.7484");
  });

  // cacheKey produces the same key for coordinates that round to the same point.
  it("builds the same key for coordinates within the rounding window", () => {
    expect(cacheKey(40.74841, -73.98571, "building")).toEqual(
      cacheKey(40.74839, -73.98572, "building")
    );
  });

  // cacheKey produces different keys for the building and block tiers at the same point.
  it("separates the two tiers at the same point", () => {
    expect(cacheKey(40.7484, -73.9857, "building")).not.toEqual(
      cacheKey(40.7484, -73.9857, "block")
    );
  });
});

describe("indexes", () => {
  // ensureCacheIndexes creates a unique coord_tier index and a 24-hour TTL index on complaint_cache.
  it("creates the compound lookup index and the TTL index", async () => {
    await ensureCacheIndexes();
    const db = await getDb();
    const indexes = await db.collection(CACHE_COLLECTION).indexes();
    const byName = Object.fromEntries(indexes.map((i) => [i.name, i]));

    expect(byName.coord_tier.key).toEqual({ lat: 1, lng: 1, radiusTier: 1 });
    expect(byName.coord_tier.unique).toBe(true);
    expect(byName.createdAt_ttl.expireAfterSeconds).toBe(CACHE_TTL_SECONDS);
    expect(CACHE_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  // ensureCacheIndexes creates no 2dsphere index.
  it("creates NO 2dsphere index — spatial filtering is Socrata's job", async () => {
    await ensureCacheIndexes();
    const db = await getDb();
    const indexes = await db.collection(CACHE_COLLECTION).indexes();
    for (const index of indexes) {
      expect(Object.values(index.key)).not.toContain("2dsphere");
    }
  });

});

describe("read / write round trip", () => {
  // readCounts returns null for each requested tier when nothing is cached.
  it("returns null for an uncached point", async () => {
    expect(await readCounts(40.7484, -73.9857, ["building", "block"])).toEqual({
      building: null,
      block: null,
    });
  });

  // readCounts returns exactly the counts that writeCounts stored.
  it("reads back exactly what was written", async () => {
    await writeCounts(40.7484, -73.9857, "building", BUILDING);
    const result = await readCounts(40.7484, -73.9857, ["building"]);
    expect(result.building).toEqual(BUILDING);
  });

  // readCounts returns both tiers' counts together when both are cached.
  it("fetches both tiers in one query", async () => {
    await writeCounts(40.7484, -73.9857, "building", BUILDING);
    await writeCounts(40.7484, -73.9857, "block", BLOCK);
    expect(await readCounts(40.7484, -73.9857, ["building", "block"])).toEqual({
      building: BUILDING,
      block: BLOCK,
    });
  });

  // readCounts returns the cached tier and null for the uncached one on a partial hit.
  it("reports a partial hit when only one tier is cached", async () => {
    await writeCounts(40.7484, -73.9857, "block", BLOCK);
    expect(await readCounts(40.7484, -73.9857, ["building", "block"])).toEqual({
      building: null,
      block: BLOCK,
    });
  });

  // readCounts hits for coordinates that round onto the stored key.
  it("hits for a coordinate that rounds onto the stored key", async () => {
    await writeCounts(40.748412, -73.985712, "building", BUILDING);
    expect((await readCounts(40.748389, -73.98573, ["building"])).building).toEqual(
      BUILDING
    );
  });

  // readCounts misses for a clearly different location.
  it("misses for a genuinely different location", async () => {
    await writeCounts(40.7484, -73.9857, "building", BUILDING);
    expect(
      (await readCounts(40.6944, -73.9213, ["building"])).building
    ).toBeNull();
  });

  // readCounts does not return one tier's counts under the other tier.
  it("does not return one tier's counts under the other tier's key", async () => {
    await writeCounts(40.7484, -73.9857, "building", BUILDING);
    expect((await readCounts(40.7484, -73.9857, ["block"])).block).toBeNull();
  });

  // readCounts returns an all-zero count document as a hit, not a miss.
  it("preserves zero counts rather than treating them as absent", async () => {
    // A genuine all-zero building result is meaningful (M4 flags it as
    // low-confidence); it must not be indistinguishable from a cache miss.
    const zeros = { heatHotWater: 0, unsanitaryCondition: 0, plumbing: 0, repairs: 0, electricGas: 0, buildingSafety: 0 };
    await writeCounts(40.7484, -73.9857, "building", zeros);
    expect((await readCounts(40.7484, -73.9857, ["building"])).building).toEqual(
      zeros
    );
  });
});

describe("document shape", () => {
  // writeCounts stores the rounded lat/lng, tier, counts and createdAt as a real Date.
  it("stores the rounded key, the counts, and a BSON Date", async () => {
    await writeCounts(40.748412, -73.985712, "building", BUILDING);
    const db = await getDb();
    const doc = await db.collection(CACHE_COLLECTION).findOne({});

    expect(doc.lat).toBe(40.7484);
    expect(doc.lng).toBe(-73.9857);
    expect(doc.radiusTier).toBe("building");
    expect(doc.counts).toEqual(BUILDING);
    // A string createdAt is silently ignored by the TTL monitor and the
    // document would then never expire.
    expect(doc.createdAt).toBeInstanceOf(Date);
  });

  // writeCounts upserts the same key in place and moves createdAt forward on refresh.
  it("upserts in place and slides createdAt forward on refresh", async () => {
    const db = await getDb();
    const old = new Date("2026-08-01T00:00:00Z");
    await writeCounts(40.7484, -73.9857, "building", BUILDING, { now: old });

    const fresh = new Date("2026-08-15T00:00:00Z");
    const updated = { ...BUILDING, plumbing: 9 };
    await writeCounts(40.7484, -73.9857, "building", updated, { now: fresh });

    const docs = await db.collection(CACHE_COLLECTION).find({}).toArray();
    expect(docs).toHaveLength(1); // refreshed, not duplicated
    expect(docs[0].counts).toEqual(updated);
    expect(docs[0].createdAt.toISOString()).toBe(fresh.toISOString());
  });

  // Concurrent writeCounts calls for one key leave a single document.
  it("keeps concurrent writes for the same key to a single document", async () => {
    await ensureCacheIndexes();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        writeCounts(40.7484, -73.9857, "building", BUILDING)
      )
    );
    const db = await getDb();
    expect(
      await db.collection(CACHE_COLLECTION).countDocuments({ radiusTier: "building" })
    ).toBe(1);
  });
});

describe("corrupt documents", () => {
  // readCounts treats a cached document missing a bucket as a miss.
  it("treats a document with a missing bucket as a miss", async () => {
    // A missing bucket would enter the scoring mean as NaN and silently poison
    // the whole sub-score, so a partial document must not count as a hit.
    const db = await getDb();
    await db.collection(CACHE_COLLECTION).insertOne({
      lat: 40.7484,
      lng: -73.9857,
      radiusTier: "building",
      counts: { heatHotWater: 5, plumbing: 1 }, // unsanitaryCondition absent
      createdAt: new Date(),
    });
    expect(
      (await readCounts(40.7484, -73.9857, ["building"])).building
    ).toBeNull();
  });

  // readCounts treats a cached document with non-numeric counts as a miss.
  it("treats non-numeric counts as a miss", async () => {
    const db = await getDb();
    await db.collection(CACHE_COLLECTION).insertOne({
      lat: 40.7484,
      lng: -73.9857,
      radiusTier: "block",
      counts: { noise: "1653", parking: 402, streetCondition: 88, sanitation: 0, infrastructure: 0, publicSafety: 0 },
      createdAt: new Date(),
    });
    expect((await readCounts(40.7484, -73.9857, ["block"])).block).toBeNull();
  });
});

describe("degradation", () => {
  // readCounts and writeCounts return a miss and false, without throwing, when MONGODB_URI is unset.
  it("reports a miss and does not throw when MONGODB_URI is unset", async () => {
    const uri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      expect(isMongoConfigured()).toBe(false);
      expect(await readCounts(40.7484, -73.9857, ["building"])).toEqual({
        building: null,
      });
      expect(await writeCounts(40.7484, -73.9857, "building", BUILDING)).toBe(
        false
      );
    } finally {
      process.env.MONGODB_URI = uri;
    }
  });

  // readCounts and writeCounts return a miss and false, with a warning, when Mongo is unreachable.
  it("reports a miss and does not throw when Mongo is unreachable", async () => {
    // The failure that matters on demo day: Atlas is configured but down. The
    // score endpoint must fall through to Socrata, not 500.
    const good = process.env.MONGODB_URI;
    await closeMongo();
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1/deadhost";
    process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS = "300";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(await readCounts(40.7484, -73.9857, ["building"])).toEqual({
        building: null,
      });
      expect(await writeCounts(40.7484, -73.9857, "building", BUILDING)).toBe(
        false
      );
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await closeMongo();
      delete process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS;
      process.env.MONGODB_URI = good;
    }
  });
});

// --- explanations stored alongside counts ------------------------------------

describe("explanation caching", () => {
  const LAT = 40.7484;
  const LNG = -73.9857;
  const COUNTS = { heatHotWater: 12, unsanitaryCondition: 3, plumbing: 1, repairs: 0, electricGas: 0, buildingSafety: 0 };

  beforeEach(async () => {
    await writeCounts(LAT, LNG, "building", COUNTS);
  });

  // readEntries returns counts together with the stored explanation and its source.
  it("readEntries returns counts and explanation together in one query", async () => {
    await writeExplanation(LAT, LNG, "building", "Generated text.", "ai");

    const entries = await readEntries(LAT, LNG, ["building"]);
    expect(entries.building.counts).toEqual(COUNTS);
    expect(entries.building.explanation).toBe("Generated text.");
    expect(entries.building.explanationSource).toBe("ai");
  });

  // readEntries returns null explanation and source when none has been written.
  it("reports a null explanation when none has been generated yet", async () => {
    const entries = await readEntries(LAT, LNG, ["building"]);
    expect(entries.building.counts).toEqual(COUNTS);
    expect(entries.building.explanation).toBeNull();
    expect(entries.building.explanationSource).toBeNull();
  });

  // writeExplanation leaves the cached counts unchanged.
  it("writing an explanation does not disturb the counts", async () => {
    await writeExplanation(LAT, LNG, "building", "Generated text.", "ai");
    const counts = await readCounts(LAT, LNG, ["building"]);
    expect(counts.building).toEqual(COUNTS);
  });

  // writeExplanation does not move createdAt, so it never extends the counts' TTL.
  it("does not extend the TTL of the counts it describes", async () => {
    // Refreshing createdAt here would let a much-explained address keep stale
    // counts alive indefinitely.
    const db = await getDb();
    const before = await db.collection(CACHE_COLLECTION).findOne({ radiusTier: "building" });
    await writeExplanation(LAT, LNG, "building", "Generated text.", "ai");
    const after = await db.collection(CACHE_COLLECTION).findOne({ radiusTier: "building" });

    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(after.explanationAt).toBeInstanceOf(Date);
  });

  // writeCounts removes the stored explanation when the counts are refreshed.
  it("refreshing the counts drops the explanation that described them", async () => {
    // An explanation written about last week's counts must not survive onto
    // this week's.
    await writeExplanation(LAT, LNG, "building", "Generated text.", "ai");
    await writeCounts(LAT, LNG, "building", { ...COUNTS, heatHotWater: 99 });

    const entries = await readEntries(LAT, LNG, ["building"]);
    expect(entries.building.counts.heatHotWater).toBe(99);
    expect(entries.building.explanation).toBeNull();
  });

  // writeExplanation returns false and creates no document when the counts have expired.
  it("does not create a document when the counts have expired", async () => {
    // A bare explanation with no counts is unusable — readEntries would reject
    // it as incomplete anyway.
    const db = await getDb();
    await db.collection(CACHE_COLLECTION).deleteMany({});

    const written = await writeExplanation(LAT, LNG, "building", "Orphan.", "ai");
    expect(written).toBe(false);
    expect(await db.collection(CACHE_COLLECTION).countDocuments()).toBe(0);
  });

  // writeExplanation returns false rather than throwing when Mongo is unreachable.
  it("returns false rather than throwing when Mongo is unreachable", async () => {
    const uri = process.env.MONGODB_URI;
    await closeMongo();
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1/nope";
    process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS = "150";

    await expect(
      writeExplanation(LAT, LNG, "building", "text", "ai")
    ).resolves.toBe(false);

    await closeMongo();
    process.env.MONGODB_URI = uri;
    delete process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS;
  });
});

describe("amenity distance caching", () => {
  const LAT = 40.7215;
  const LNG = -73.9878;
  const DISTANCES = { transit: { subway: { meters: 174, name: "2 Av" } } };

  // Amenity walking distances round-trip through writeAmenityDistances and readAmenityDistances.
  it("round-trips through Mongo", async () => {
    const written = await writeAmenityDistances(LAT, LNG, DISTANCES);
    expect(written).toBe(true);

    const read = await readAmenityDistances(LAT, LNG);
    expect(read).toEqual(DISTANCES);
  });

  // readAmenityDistances returns null when nothing has been written.
  it("reports a miss (null) when nothing has been written yet", async () => {
    expect(await readAmenityDistances(LAT, LNG)).toBeNull();
  });

  // Amenity distances and complaint counts for the same coordinate are stored separately and both stay readable.
  it("does not collide with a complaint-count document for the same coordinate", async () => {
    // These now live in SEPARATE collections, so this is no longer about a
    // radiusTier discriminator — it guards that the split kept both readable
    // for the same coordinate rather than one shadowing the other.
    await writeCounts(LAT, LNG, "building", { heatHotWater: 1, unsanitaryCondition: 0, plumbing: 0, repairs: 0, electricGas: 0, buildingSafety: 0 });
    await writeAmenityDistances(LAT, LNG, DISTANCES);

    const counts = await readCounts(LAT, LNG, ["building"]);
    expect(counts.building).toEqual({ heatHotWater: 1, unsanitaryCondition: 0, plumbing: 0, repairs: 0, electricGas: 0, buildingSafety: 0 });
    expect(await readAmenityDistances(LAT, LNG)).toEqual(DISTANCES);
  });

  // The amenity_distance_cache has a unique coord index and its own TTL, longer than complaint_cache's 24h.
  it("expires on its OWN long TTL, not complaint_cache's 24h one", async () => {
    // The whole point of the dedicated collection. Mongo ties
    // expireAfterSeconds to the collection's index, so while these documents
    // sat in CACHE_COLLECTION they inherited its 24h expiry — and a walking
    // distance that is stable for years was re-bought from Google (at ~27
    // billed route-matrix elements a time) every single morning.
    await ensureAmenityDistanceCacheIndexes();
    const db = await getDb();
    const indexes = await db.collection(AMENITY_DISTANCE_CACHE_COLLECTION).indexes();
    const byName = Object.fromEntries(indexes.map((i) => [i.name, i]));

    expect(byName.coord.key).toEqual({ lat: 1, lng: 1 });
    expect(byName.coord.unique).toBe(true);
    expect(byName.createdAt_ttl.expireAfterSeconds).toBe(AMENITY_DISTANCE_CACHE_TTL_SECONDS);
    expect(AMENITY_DISTANCE_CACHE_TTL_SECONDS).toBeGreaterThan(CACHE_TTL_SECONDS);
  });

  // Amenity distance reads and writes return null and false rather than throwing when Mongo is unreachable.
  it("returns null / false rather than throwing when Mongo is unreachable", async () => {
    const uri = process.env.MONGODB_URI;
    await closeMongo();
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1/nope";
    process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS = "150";

    await expect(writeAmenityDistances(LAT, LNG, DISTANCES)).resolves.toBe(false);
    await expect(readAmenityDistances(LAT, LNG)).resolves.toBeNull();

    await closeMongo();
    process.env.MONGODB_URI = uri;
    delete process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS;
  });
});

describe("grouped complaint cache", () => {
  const GROUPS = [
    { day: "2026-08-14", type: "Noise - Residential", statusBucket: "closed", count: 7 },
    { day: "2024-11-02", type: "Street Condition", statusBucket: "open", count: 5 },
  ];

  beforeEach(async () => {
    const db = await getDb();
    await db.collection(COMPLAINT_GROUPS_COLLECTION).deleteMany({});
  });

  // writeComplaintGroups and readComplaintGroups round-trip the groups and truncated:false.
  it("round-trips groups and the truncation flag", async () => {
    await writeComplaintGroups(40.7484, -73.9857, "block", GROUPS, false);
    expect(await readComplaintGroups(40.7484, -73.9857, "block")).toEqual({
      groups: GROUPS,
      truncated: false,
    });
  });

  // readComplaintGroups preserves truncated:true.
  it("preserves truncated:true, which the UI relies on to stay honest", async () => {
    await writeComplaintGroups(40.7484, -73.9857, "block", GROUPS, true);
    const hit = await readComplaintGroups(40.7484, -73.9857, "block");
    expect(hit.truncated).toBe(true);
  });

  // readComplaintGroups returns null for an unseen coordinate.
  it("misses on an unseen coordinate", async () => {
    expect(await readComplaintGroups(40.6944, -73.9213, "block")).toBeNull();
  });

  // readComplaintGroups returns null for the other tier at the same point.
  it("separates the two tiers at the same point", async () => {
    await writeComplaintGroups(40.7484, -73.9857, "block", GROUPS, false);
    expect(await readComplaintGroups(40.7484, -73.9857, "building")).toBeNull();
  });

  // No months in the key, unlike the trend cache: rows are stored newest-day
  // first, so every window is a prefix of the one entry.
  // readComplaintGroups serves any window from one entry, matching a coordinate that rounds to the same key.
  it("answers any window from a single entry", async () => {
    await writeComplaintGroups(40.7484, -73.9857, "block", GROUPS, false);
    const hit = await readComplaintGroups(40.74839, -73.98572, "block");
    expect(hit.groups).toHaveLength(2);
  });

  // writeComplaintGroups overwrites the existing document on a refill instead of duplicating.
  it("overwrites rather than duplicating on a refill", async () => {
    await writeComplaintGroups(40.7484, -73.9857, "block", GROUPS, false);
    await writeComplaintGroups(40.7484, -73.9857, "block", [GROUPS[0]], false);
    const db = await getDb();
    expect(await db.collection(COMPLAINT_GROUPS_COLLECTION).countDocuments()).toBe(1);
    const hit = await readComplaintGroups(40.7484, -73.9857, "block");
    expect(hit.groups).toHaveLength(1);
  });

  // ensureComplaintGroupsIndexes creates a unique coord_tier index and the TTL index.
  it("creates the lookup and TTL indexes", async () => {
    await ensureComplaintGroupsIndexes();
    const db = await getDb();
    const indexes = await db.collection(COMPLAINT_GROUPS_COLLECTION).indexes();
    const byName = Object.fromEntries(indexes.map((i) => [i.name, i]));
    expect(byName.coord_tier.unique).toBe(true);
    expect(byName.createdAt_ttl.expireAfterSeconds).toBe(CACHE_TTL_SECONDS);
  });

  // readComplaintGroups treats a document without a groups array as a miss.
  it("treats a document with no groups array as a miss, not a crash", async () => {
    const db = await getDb();
    await db.collection(COMPLAINT_GROUPS_COLLECTION).insertOne({
      ...cacheKey(40.7484, -73.9857, "block"),
      createdAt: new Date(),
    });
    expect(await readComplaintGroups(40.7484, -73.9857, "block")).toBeNull();
  });
});

describe("complaint-type signature", () => {
  // Documents built under an older complaint-type definition (a folded type,
  // a new excluded descriptor) keep every bucket name, so the completeness
  // checks alone cannot tell them apart. The signature can.
  const LAT = 40.7484;
  const LNG = -73.9857;

  /** Rewrites one stored document as if an earlier definition had written it. */
  async function ageSignature(collection, filter) {
    const db = await getDb();
    const result = await db
      .collection(collection)
      .updateOne(filter, { $set: { typeSignature: "0000000000000000" } });
    expect(result.matchedCount).toBe(1);
  }

  // typeSignature is stable for a tier, differs between tiers, and differs for the tier-less (both-tiers) case.
  it("is stable per tier, differs between tiers, and covers both when tier-less", () => {
    expect(typeSignature("building")).toBe(typeSignature("building"));
    expect(typeSignature("building")).not.toBe(typeSignature("block"));
    expect(typeSignature(undefined)).not.toBe(typeSignature("block"));
  });

  // readCounts treats counts stamped with a different type signature as a miss.
  it("treats counts from another definition as a miss", async () => {
    await writeCounts(LAT, LNG, "block", BLOCK);
    expect((await readCounts(LAT, LNG, ["block"])).block).toEqual(BLOCK);
    await ageSignature(CACHE_COLLECTION, cacheKey(LAT, LNG, "block"));
    expect((await readCounts(LAT, LNG, ["block"])).block).toBeNull();
  });

  // readCounts treats counts with no type signature (older documents) as a miss.
  it("treats counts with no signature at all (pre-signature documents) as a miss", async () => {
    const db = await getDb();
    await db.collection(CACHE_COLLECTION).insertOne({
      ...cacheKey(LAT, LNG, "block"),
      counts: BLOCK,
      createdAt: new Date(),
    });
    expect((await readCounts(LAT, LNG, ["block"])).block).toBeNull();
  });

  // readComplaintGroups treats grouped rows stamped with a different type signature as a miss.
  it("treats grouped rows from another definition as a miss", async () => {
    const db = await getDb();
    await db.collection(COMPLAINT_GROUPS_COLLECTION).deleteMany({});
    await writeComplaintGroups(LAT, LNG, "block", [], false);
    expect(await readComplaintGroups(LAT, LNG, "block")).not.toBeNull();
    await ageSignature(COMPLAINT_GROUPS_COLLECTION, cacheKey(LAT, LNG, "block"));
    expect(await readComplaintGroups(LAT, LNG, "block")).toBeNull();
  });

  // readTrend treats a trend series stamped with a different type signature as a miss.
  it("treats a trend series from another definition as a miss", async () => {
    const db = await getDb();
    await db.collection(TREND_CACHE_COLLECTION).deleteMany({});
    const points = [{ month: "2026-08", count: 4 }];
    await writeTrend(LAT, LNG, "block", 1, points);
    expect(await readTrend(LAT, LNG, "block", 1)).toEqual(points);
    await ageSignature(TREND_CACHE_COLLECTION, { lat: LAT, lng: LNG, radiusTier: "block", months: 1 });
    expect(await readTrend(LAT, LNG, "block", 1)).toBeNull();
  });
});
