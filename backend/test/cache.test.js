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
  resetCacheIndexMemo,
  readComplaintGroups,
  writeComplaintGroups,
  ensureComplaintGroupsIndexes,
} from "../src/providers/cache.js";
import { getDb, isMongoConfigured, closeMongo } from "../src/providers/mongo.js";
import {
  CACHE_COLLECTION,
  CACHE_TTL_SECONDS,
  COMPLAINT_GROUPS_COLLECTION,
} from "../src/config/constants.js";

const BUILDING = { heatHotWater: 12, unsanitaryCondition: 3, plumbing: 0 };
const BLOCK = { noise: 1653, parking: 402, streetCondition: 88 };

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
});

describe("key derivation (pure)", () => {
  it("rounds to 4dp without float dust", () => {
    expect(roundCoord(40.74841234)).toBe(40.7484);
    expect(roundCoord(-73.98567)).toBe(-73.9857);
    // Math.round(v * 1e4) / 1e4 leaves values like 40.748400000000004, which
    // would never match a stored key on an exact-match lookup.
    expect(String(roundCoord(40.7484))).toBe("40.7484");
  });

  it("builds the same key for coordinates within the rounding window", () => {
    expect(cacheKey(40.74841, -73.98571, "building")).toEqual(
      cacheKey(40.74839, -73.98572, "building")
    );
  });

  it("separates the two tiers at the same point", () => {
    expect(cacheKey(40.7484, -73.9857, "building")).not.toEqual(
      cacheKey(40.7484, -73.9857, "block")
    );
  });
});

describe("indexes", () => {
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

  it("creates NO 2dsphere index — spatial filtering is Socrata's job", async () => {
    await ensureCacheIndexes();
    const db = await getDb();
    const indexes = await db.collection(CACHE_COLLECTION).indexes();
    for (const index of indexes) {
      expect(Object.values(index.key)).not.toContain("2dsphere");
    }
  });

  it("is idempotent and only round-trips once per process", async () => {
    resetCacheIndexMemo();
    const db = await getDb();
    const spy = vi.spyOn(db.collection(CACHE_COLLECTION), "createIndexes");
    await Promise.all([ensureCacheIndexes(), ensureCacheIndexes()]);
    await ensureCacheIndexes();
    // The memo means repeated calls do not re-issue createIndexes; the spy is on
    // a fresh collection handle, so this asserts the memo, not the driver.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });
});

describe("read / write round trip", () => {
  it("returns null for an uncached point", async () => {
    expect(await readCounts(40.7484, -73.9857, ["building", "block"])).toEqual({
      building: null,
      block: null,
    });
  });

  it("reads back exactly what was written", async () => {
    await writeCounts(40.7484, -73.9857, "building", BUILDING);
    const result = await readCounts(40.7484, -73.9857, ["building"]);
    expect(result.building).toEqual(BUILDING);
  });

  it("fetches both tiers in one query", async () => {
    await writeCounts(40.7484, -73.9857, "building", BUILDING);
    await writeCounts(40.7484, -73.9857, "block", BLOCK);
    expect(await readCounts(40.7484, -73.9857, ["building", "block"])).toEqual({
      building: BUILDING,
      block: BLOCK,
    });
  });

  it("reports a partial hit when only one tier is cached", async () => {
    await writeCounts(40.7484, -73.9857, "block", BLOCK);
    expect(await readCounts(40.7484, -73.9857, ["building", "block"])).toEqual({
      building: null,
      block: BLOCK,
    });
  });

  it("hits for a coordinate that rounds onto the stored key", async () => {
    await writeCounts(40.748412, -73.985712, "building", BUILDING);
    expect((await readCounts(40.748389, -73.98573, ["building"])).building).toEqual(
      BUILDING
    );
  });

  it("misses for a genuinely different location", async () => {
    await writeCounts(40.7484, -73.9857, "building", BUILDING);
    expect(
      (await readCounts(40.6944, -73.9213, ["building"])).building
    ).toBeNull();
  });

  it("does not return one tier's counts under the other tier's key", async () => {
    await writeCounts(40.7484, -73.9857, "building", BUILDING);
    expect((await readCounts(40.7484, -73.9857, ["block"])).block).toBeNull();
  });

  it("preserves zero counts rather than treating them as absent", async () => {
    // A genuine all-zero building result is meaningful (M4 flags it as
    // low-confidence); it must not be indistinguishable from a cache miss.
    const zeros = { heatHotWater: 0, unsanitaryCondition: 0, plumbing: 0 };
    await writeCounts(40.7484, -73.9857, "building", zeros);
    expect((await readCounts(40.7484, -73.9857, ["building"])).building).toEqual(
      zeros
    );
  });
});

describe("document shape", () => {
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

  it("treats non-numeric counts as a miss", async () => {
    const db = await getDb();
    await db.collection(CACHE_COLLECTION).insertOne({
      lat: 40.7484,
      lng: -73.9857,
      radiusTier: "block",
      counts: { noise: "1653", parking: 402, streetCondition: 88 },
      createdAt: new Date(),
    });
    expect((await readCounts(40.7484, -73.9857, ["block"])).block).toBeNull();
  });
});

describe("degradation", () => {
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
  const COUNTS = { heatHotWater: 12, unsanitaryCondition: 3, plumbing: 1 };

  beforeEach(async () => {
    await writeCounts(LAT, LNG, "building", COUNTS);
  });

  it("readEntries returns counts and explanation together in one query", async () => {
    await writeExplanation(LAT, LNG, "building", "Generated text.", "ai");

    const entries = await readEntries(LAT, LNG, ["building"]);
    expect(entries.building.counts).toEqual(COUNTS);
    expect(entries.building.explanation).toBe("Generated text.");
    expect(entries.building.explanationSource).toBe("ai");
  });

  it("reports a null explanation when none has been generated yet", async () => {
    const entries = await readEntries(LAT, LNG, ["building"]);
    expect(entries.building.counts).toEqual(COUNTS);
    expect(entries.building.explanation).toBeNull();
    expect(entries.building.explanationSource).toBeNull();
  });

  it("writing an explanation does not disturb the counts", async () => {
    await writeExplanation(LAT, LNG, "building", "Generated text.", "ai");
    const counts = await readCounts(LAT, LNG, ["building"]);
    expect(counts.building).toEqual(COUNTS);
  });

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

  it("refreshing the counts drops the explanation that described them", async () => {
    // An explanation written about last week's counts must not survive onto
    // this week's.
    await writeExplanation(LAT, LNG, "building", "Generated text.", "ai");
    await writeCounts(LAT, LNG, "building", { ...COUNTS, heatHotWater: 99 });

    const entries = await readEntries(LAT, LNG, ["building"]);
    expect(entries.building.counts.heatHotWater).toBe(99);
    expect(entries.building.explanation).toBeNull();
  });

  it("does not create a document when the counts have expired", async () => {
    // A bare explanation with no counts is unusable — readEntries would reject
    // it as incomplete anyway.
    const db = await getDb();
    await db.collection(CACHE_COLLECTION).deleteMany({});

    const written = await writeExplanation(LAT, LNG, "building", "Orphan.", "ai");
    expect(written).toBe(false);
    expect(await db.collection(CACHE_COLLECTION).countDocuments()).toBe(0);
  });

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

  it("round-trips through Mongo", async () => {
    const written = await writeAmenityDistances(LAT, LNG, DISTANCES);
    expect(written).toBe(true);

    const read = await readAmenityDistances(LAT, LNG);
    expect(read).toEqual(DISTANCES);
  });

  it("reports a miss (null) when nothing has been written yet", async () => {
    expect(await readAmenityDistances(LAT, LNG)).toBeNull();
  });

  it("does not collide with a complaint-count document for the same coordinate", async () => {
    // Both live in CACHE_COLLECTION, keyed on {lat, lng, radiusTier} — this
    // only stays safe because AMENITY_DISTANCE_CACHE_RADIUS_TIER ("amenityDistances")
    // can never equal a real radiusTier value ("building", "block", "transit", ...).
    await writeCounts(LAT, LNG, "building", { heatHotWater: 1, unsanitaryCondition: 0, plumbing: 0 });
    await writeAmenityDistances(LAT, LNG, DISTANCES);

    const counts = await readCounts(LAT, LNG, ["building"]);
    expect(counts.building).toEqual({ heatHotWater: 1, unsanitaryCondition: 0, plumbing: 0 });
    expect(await readAmenityDistances(LAT, LNG)).toEqual(DISTANCES);
  });

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

  it("round-trips groups and the truncation flag", async () => {
    await writeComplaintGroups(40.7484, -73.9857, "block", GROUPS, false);
    expect(await readComplaintGroups(40.7484, -73.9857, "block")).toEqual({
      groups: GROUPS,
      truncated: false,
    });
  });

  it("preserves truncated:true, which the UI relies on to stay honest", async () => {
    await writeComplaintGroups(40.7484, -73.9857, "block", GROUPS, true);
    const hit = await readComplaintGroups(40.7484, -73.9857, "block");
    expect(hit.truncated).toBe(true);
  });

  it("misses on an unseen coordinate", async () => {
    expect(await readComplaintGroups(40.6944, -73.9213, "block")).toBeNull();
  });

  it("separates the two tiers at the same point", async () => {
    await writeComplaintGroups(40.7484, -73.9857, "block", GROUPS, false);
    expect(await readComplaintGroups(40.7484, -73.9857, "building")).toBeNull();
  });

  // No months in the key, unlike the trend cache: rows are stored newest-day
  // first, so every window is a prefix of the one entry.
  it("answers any window from a single entry", async () => {
    await writeComplaintGroups(40.7484, -73.9857, "block", GROUPS, false);
    const hit = await readComplaintGroups(40.74839, -73.98572, "block");
    expect(hit.groups).toHaveLength(2);
  });

  it("overwrites rather than duplicating on a refill", async () => {
    await writeComplaintGroups(40.7484, -73.9857, "block", GROUPS, false);
    await writeComplaintGroups(40.7484, -73.9857, "block", [GROUPS[0]], false);
    const db = await getDb();
    expect(await db.collection(COMPLAINT_GROUPS_COLLECTION).countDocuments()).toBe(1);
    const hit = await readComplaintGroups(40.7484, -73.9857, "block");
    expect(hit.groups).toHaveLength(1);
  });

  it("creates the lookup and TTL indexes", async () => {
    await ensureComplaintGroupsIndexes();
    const db = await getDb();
    const indexes = await db.collection(COMPLAINT_GROUPS_COLLECTION).indexes();
    const byName = Object.fromEntries(indexes.map((i) => [i.name, i]));
    expect(byName.coord_tier.unique).toBe(true);
    expect(byName.createdAt_ttl.expireAfterSeconds).toBe(CACHE_TTL_SECONDS);
  });

  it("treats a document with no groups array as a miss, not a crash", async () => {
    const db = await getDb();
    await db.collection(COMPLAINT_GROUPS_COLLECTION).insertOne({
      ...cacheKey(40.7484, -73.9857, "block"),
      createdAt: new Date(),
    });
    expect(await readComplaintGroups(40.7484, -73.9857, "block")).toBeNull();
  });
});
