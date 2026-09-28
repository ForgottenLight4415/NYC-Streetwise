import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startMongo } from "./helpers/mongoTestServer.js";
import {
  ensureAddressLookupIndexes,
  lookupKey,
  recentLookups,
  recordCurated,
  recordLookup,
  sampleLookups,
  topLookups,
} from "../src/providers/addressDirectory.js";
import { getDb, closeMongo } from "../src/providers/mongo.js";
import { ADDRESS_LOOKUPS_COLLECTION } from "../src/config/constants.js";

// The address directory against a real in-memory mongod, for the same reason
// cache.test.js uses one: what matters here is upsert semantics, the unique
// coordinate constraint, and sort order — none of which a stub would assert.

const PARK = { address: "456 Park Ave, New York, NY 10022", borough: "Manhattan", lat: 40.7614, lng: -73.9707 };
const LUDLOW = { address: "123 Ludlow St, New York, NY 10002", borough: "Manhattan", lat: 40.7202, lng: -73.9877 };

let mongo;

beforeAll(async () => {
  mongo = await startMongo();
});

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(ADDRESS_LOOKUPS_COLLECTION).deleteMany({});
});

async function rows() {
  const db = await getDb();
  return db.collection(ADDRESS_LOOKUPS_COLLECTION).find({}).toArray();
}

describe("key derivation", () => {
  it("rounds to the same precision the counts cache keys on", () => {
    // The join to complaint_cache is the entire point: an unrounded key here
    // would name coordinates whose counts could never be found.
    expect(lookupKey(40.76141234, -73.97071234)).toEqual({ lat: 40.7614, lng: -73.9707 });
  });
});

describe("recordLookup", () => {
  it("inserts a row with a lookup counter and both timestamps", async () => {
    const now = new Date("2026-08-18T12:00:00Z");
    expect(await recordLookup(PARK, { now })).toBe(true);

    const [doc] = await rows();
    expect(doc).toMatchObject({
      address: PARK.address,
      borough: "Manhattan",
      lat: 40.7614,
      lng: -73.9707,
      lookups: 1,
      curated: false,
    });
    expect(doc.firstSeenAt).toEqual(now);
    expect(doc.lastSeenAt).toEqual(now);
  });

  it("increments rather than duplicating on a second lookup", async () => {
    await recordLookup(PARK, { now: new Date("2026-08-18T12:00:00Z") });
    await recordLookup(PARK, { now: new Date("2026-08-19T12:00:00Z") });

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].lookups).toBe(2);
    // firstSeenAt is the first visit, lastSeenAt the latest — the pair is what
    // lets mode=top break ties by recency.
    expect(all[0].firstSeenAt).toEqual(new Date("2026-08-18T12:00:00Z"));
    expect(all[0].lastSeenAt).toEqual(new Date("2026-08-19T12:00:00Z"));
  });

  it("keeps the first address text for a coordinate", async () => {
    await recordLookup(PARK);
    // Same building, different formatting — rounds to the same key.
    await recordLookup({ ...PARK, address: "456 Park Avenue, New York, NY 10022" });

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].address).toBe("456 Park Ave, New York, NY 10022");
    expect(all[0].lookups).toBe(2);
  });

  it("trims the stored address", async () => {
    await recordLookup({ ...PARK, address: "  456 Park Ave  " });
    expect((await rows())[0].address).toBe("456 Park Ave");
  });

  it("stores null for an undeterminable borough rather than omitting the field", async () => {
    await recordLookup({ ...PARK, borough: null });
    expect((await rows())[0].borough).toBeNull();
  });

  it("refuses a blank address instead of storing an unnameable row", async () => {
    expect(await recordLookup({ ...PARK, address: "   " })).toBe(false);
    expect(await rows()).toHaveLength(0);
  });

  it("survives concurrent first-lookups of one address as a single row", async () => {
    // This is what the unique index buys: without it a race leaves two rows with
    // the count split, and the homepage renders the address twice.
    await ensureAddressLookupIndexes();
    await Promise.all([recordLookup(PARK), recordLookup(PARK), recordLookup(PARK)]);

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].lookups).toBe(3);
  });
});

describe("recordCurated", () => {
  it("inserts at zero lookups so real traffic outranks a seed", async () => {
    await recordCurated(PARK);
    const [doc] = await rows();
    expect(doc).toMatchObject({ curated: true, lookups: 0 });
  });

  it("flags an already-searched address without inflating its counter", async () => {
    await recordLookup(PARK);
    await recordLookup(PARK);
    await recordCurated(PARK);

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].lookups).toBe(2);
    expect(all[0].curated).toBe(true);
  });
});

describe("read modes", () => {
  beforeEach(async () => {
    await recordLookup(LUDLOW, { now: new Date("2026-08-10T00:00:00Z") });
    await recordLookup(LUDLOW, { now: new Date("2026-08-11T00:00:00Z") });
    await recordLookup(LUDLOW, { now: new Date("2026-08-12T00:00:00Z") });
    await recordLookup(PARK, { now: new Date("2026-08-18T00:00:00Z") });
  });

  it("topLookups sorts by popularity", async () => {
    const [first, second] = await topLookups(10);
    expect(first.address).toBe(LUDLOW.address);
    expect(second.address).toBe(PARK.address);
  });

  it("recentLookups sorts by recency, which is a different order", async () => {
    const [first] = await recentLookups(10);
    expect(first.address).toBe(PARK.address);
  });

  it("respects the limit", async () => {
    expect(await topLookups(1)).toHaveLength(1);
  });

  it("sampleLookups returns rows, capped at the collection size", async () => {
    const sampled = await sampleLookups(10);
    expect(sampled).toHaveLength(2);
    expect(sampled.map((r) => r.address).sort()).toEqual(
      [LUDLOW.address, PARK.address].sort()
    );
  });

  it("omits _id so a row can be spread straight into a response", async () => {
    const [doc] = await topLookups(1);
    expect(doc._id).toBeUndefined();
  });
});

describe("degradation", () => {
  it("reads empty and writes false with Mongo unconfigured", async () => {
    const uri = process.env.MONGODB_URI;
    await closeMongo();
    delete process.env.MONGODB_URI;
    try {
      // A directory outage costs the homepage its cached cards, never its render.
      expect(await topLookups(4)).toEqual([]);
      expect(await recentLookups(4)).toEqual([]);
      expect(await sampleLookups(4)).toEqual([]);
      expect(await recordLookup(PARK)).toBe(false);
      expect(await recordCurated(PARK)).toBe(false);
    } finally {
      process.env.MONGODB_URI = uri;
      await closeMongo();
    }
  });

  it("does not throw when Mongo is unreachable", async () => {
    // Configured but down — the Atlas-outage case. The homepage still renders.
    const uri = process.env.MONGODB_URI;
    await closeMongo();
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1/deadhost";
    // Without this the driver waits out its own 8s selection timeout, twice.
    process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS = "300";

    try {
      await expect(topLookups(4)).resolves.toEqual([]);
      await expect(recordLookup(PARK)).resolves.toBe(false);
    } finally {
      await closeMongo();
      process.env.MONGODB_URI = uri;
      delete process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS;
    }
  });
});
