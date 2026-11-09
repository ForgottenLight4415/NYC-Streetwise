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
  // lookupKey rounds coordinates to 4 decimals, the same precision the counts cache keys on.
  it("rounds to the same precision the counts cache keys on", () => {
    // The join to complaint_cache is the entire point: an unrounded key here
    // would name coordinates whose counts could never be found.
    expect(lookupKey(40.76141234, -73.97071234)).toEqual({ lat: 40.7614, lng: -73.9707 });
  });
});

describe("recordLookup", () => {
  // recordLookup inserts a new row with lookups 1, curated false and equal firstSeenAt/lastSeenAt.
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

  // recordLookup increments the counter and updates lastSeenAt on a repeat lookup, keeping a single row and the original firstSeenAt.
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

  // recordLookup keeps the first stored address text when the same coordinate is looked up with different formatting.
  it("keeps the first address text for a coordinate", async () => {
    await recordLookup(PARK);
    // Same building, different formatting — rounds to the same key.
    await recordLookup({ ...PARK, address: "456 Park Avenue, New York, NY 10022" });

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].address).toBe("456 Park Ave, New York, NY 10022");
    expect(all[0].lookups).toBe(2);
  });

  // recordLookup trims whitespace from the stored address.
  it("trims the stored address", async () => {
    await recordLookup({ ...PARK, address: "  456 Park Ave  " });
    expect((await rows())[0].address).toBe("456 Park Ave");
  });

  // recordLookup stores borough as null when it cannot be determined.
  it("stores null for an undeterminable borough rather than omitting the field", async () => {
    await recordLookup({ ...PARK, borough: null });
    expect((await rows())[0].borough).toBeNull();
  });

  // recordLookup returns false and stores nothing for a blank address.
  it("refuses a blank address instead of storing an unnameable row", async () => {
    expect(await recordLookup({ ...PARK, address: "   " })).toBe(false);
    expect(await rows()).toHaveLength(0);
  });

  // Concurrent first lookups of the same address end up as one row with the full count, thanks to the unique index.
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
  // recordCurated inserts a curated row with zero lookups so real traffic outranks seeds.
  it("inserts at zero lookups so real traffic outranks a seed", async () => {
    await recordCurated(PARK);
    const [doc] = await rows();
    expect(doc).toMatchObject({ curated: true, lookups: 0 });
  });

  // recordCurated flags an existing row as curated without changing its lookup count.
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

  // topLookups orders rows by lookup count, most popular first.
  it("topLookups sorts by popularity", async () => {
    const [first, second] = await topLookups(10);
    expect(first.address).toBe(LUDLOW.address);
    expect(second.address).toBe(PARK.address);
  });

  // recentLookups orders rows by most recent lookup, which differs from popularity order.
  it("recentLookups sorts by recency, which is a different order", async () => {
    const [first] = await recentLookups(10);
    expect(first.address).toBe(PARK.address);
  });

  // topLookups honours the limit argument.
  it("respects the limit", async () => {
    expect(await topLookups(1)).toHaveLength(1);
  });

  // sampleLookups returns rows, capped at the number actually stored.
  it("sampleLookups returns rows, capped at the collection size", async () => {
    const sampled = await sampleLookups(10);
    expect(sampled).toHaveLength(2);
    expect(sampled.map((r) => r.address).sort()).toEqual(
      [LUDLOW.address, PARK.address].sort()
    );
  });

  // Directory reads omit Mongo's _id so rows can be spread directly into a response.
  it("omits _id so a row can be spread straight into a response", async () => {
    const [doc] = await topLookups(1);
    expect(doc._id).toBeUndefined();
  });
});

describe("degradation", () => {
  // With Mongo unconfigured, directory reads return [] and writes return false.
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

  // With Mongo configured but unreachable, directory reads return [] and writes return false without throwing.
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
