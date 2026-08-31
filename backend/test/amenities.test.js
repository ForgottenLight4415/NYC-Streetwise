import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { startMongo } from "./helpers/mongoTestServer.js";
import { getDb } from "../src/providers/mongo.js";
import {
  loadAmenities,
  saveAmenityDataset,
  isValidDataset,
  resetAmenitiesMemo,
  AMENITY_FILE_PATHS,
} from "../src/providers/amenities/index.js";
import { AMENITIES_COLLECTION, AMENITY_BUCKET_NAMES } from "../src/config/constants.js";

function bucketFixture(points) {
  const names = [];
  const pts = [];
  for (const [lat, lng, name] of points) {
    let idx = -1;
    if (name) {
      idx = names.indexOf(name);
      if (idx === -1) {
        idx = names.length;
        names.push(name);
      }
    }
    pts.push(lat, lng, idx);
  }
  return { pts, names, n: points.length };
}

function transitFixture(overrides = {}) {
  return {
    subway: bucketFixture([[40.75, -73.98, "14 St"]]),
    bus: bucketFixture([[40.76, -73.97, null]]),
    rail: bucketFixture([[40.74, -73.99, "Grand Central"]]),
    ...overrides,
  };
}

describe("isValidDataset", () => {
  it("accepts a complete transit document", () => {
    expect(isValidDataset("transit", transitFixture())).toBe(true);
  });

  it("rejects an unknown dataset name", () => {
    expect(isValidDataset("nope", transitFixture())).toBe(false);
  });

  it("rejects a document missing a bucket", () => {
    const doc = transitFixture();
    delete doc.rail;
    expect(isValidDataset("transit", doc)).toBe(false);
  });

  it("rejects a document with an extra, unexpected bucket", () => {
    const doc = transitFixture({ extraBucket: bucketFixture([[40.75, -73.98, null]]) });
    expect(isValidDataset("transit", doc)).toBe(false);
  });

  it("rejects pts whose length is not a multiple of 3", () => {
    const doc = transitFixture();
    doc.subway.pts.push(1);
    expect(isValidDataset("transit", doc)).toBe(false);
  });

  it("rejects pts/n mismatch", () => {
    const doc = transitFixture();
    doc.subway.n = 99;
    expect(isValidDataset("transit", doc)).toBe(false);
  });

  it("rejects a nameIdx pointing past the end of names", () => {
    const doc = transitFixture();
    doc.subway.pts[2] = 5; // only one name exists
    expect(isValidDataset("transit", doc)).toBe(false);
  });

  it("rejects a coordinate wildly outside the sanity range (e.g. swapped lat/lng)", () => {
    const doc = transitFixture();
    doc.subway.pts = [-73.98, 40.75, -1]; // lat/lng swapped
    doc.subway.n = 1;
    expect(isValidDataset("transit", doc)).toBe(false);
  });
});

describe("the committed amenity datasets", () => {
  it.each(Object.keys(AMENITY_FILE_PATHS))(
    "%s.json exists, is valid, and covers every expected bucket",
    async (name) => {
      const doc = JSON.parse(await readFile(AMENITY_FILE_PATHS[name], "utf8"));
      expect(isValidDataset(name, doc)).toBe(true);
      expect(Object.keys(doc).sort()).toEqual([...AMENITY_BUCKET_NAMES[name]].sort());
    }
  );
});

describe("loadAmenities without Mongo", () => {
  beforeEach(() => resetAmenitiesMemo());

  it("falls back to the committed files so a fresh clone still scores", async () => {
    const amenities = await loadAmenities();
    expect(amenities.transit).not.toBeNull();
    expect(amenities.parks).not.toBeNull();
    expect(amenities.bike).not.toBeNull();
    // Indexed and queryable, not just present.
    expect(typeof amenities.transit.subway.nearest).toBe("function");
  });

  it("memoizes — same object identity across calls", async () => {
    const first = await loadAmenities();
    const second = await loadAmenities();
    expect(second).toBe(first);
  });

  it("forceRefresh re-reads", async () => {
    const first = await loadAmenities();
    const second = await loadAmenities({ forceRefresh: true });
    expect(second).not.toBe(first);
  });
});

describe("loadAmenities with Mongo", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startMongo();
  });

  afterAll(async () => {
    await mongo.stop();
    resetAmenitiesMemo();
  });

  beforeEach(async () => {
    resetAmenitiesMemo();
    const db = await getDb();
    await db.collection(AMENITIES_COLLECTION).deleteMany({});
  });

  // Seeded via a direct insertOne rather than saveAmenityDataset: the guard
  // under test in the block below compares against whatever's already
  // "current" (Mongo, or the real committed file as fallback), and the real
  // committed transit.json has 2,120 subway points — any small fixture
  // written THROUGH the guard would itself look like a >30% drop and be
  // refused. Direct insertOne is the arrange step; saveAmenityDataset is what
  // gets exercised.

  it("prefers Mongo, so a dataset can be refreshed without a redeploy", async () => {
    const custom = transitFixture({ subway: bucketFixture([[41.0, -74.0, "Custom Stop"]]) });
    const db = await getDb();
    await db.collection(AMENITIES_COLLECTION).insertOne({ _id: "transit", ...custom });

    const amenities = await loadAmenities();
    const result = amenities.transit.subway.nearest(41.0, -74.0, 100);
    expect(result.name).toBe("Custom Stop");
  });

  it("falls back to the committed file when Mongo has no document for one dataset", async () => {
    // Only "transit" written to Mongo — "parks" and "bike" must still resolve
    // from their committed files in the same loadAmenities() call.
    const db = await getDb();
    await db.collection(AMENITIES_COLLECTION).insertOne({ _id: "transit", ...transitFixture() });

    const amenities = await loadAmenities();
    expect(amenities.parks).not.toBeNull();
    expect(amenities.bike).not.toBeNull();
  });

  it("falls back to the committed file when the Mongo document is invalid", async () => {
    const broken = transitFixture();
    delete broken.rail;
    const db = await getDb();
    await db.collection(AMENITIES_COLLECTION).insertOne({ _id: "transit", ...broken });

    const amenities = await loadAmenities();
    // Fell through to committed data, which is complete.
    expect(amenities.transit.rail).toBeDefined();
  });

  it("saveAmenityDataset upserts rather than duplicating", async () => {
    // Seed a "previous" doc of comparable size directly, so the write below
    // is measured against it rather than against the (much bigger) real
    // committed file.
    const big = transitFixture({
      subway: bucketFixture(
        Array.from({ length: 20 }, (_, i) => [40.7 + i * 0.001, -73.9, `stop-${i}`])
      ),
    });
    const db = await getDb();
    await db.collection(AMENITIES_COLLECTION).insertOne({ _id: "transit", ...big });

    const updated = transitFixture({
      subway: bucketFixture(
        Array.from({ length: 20 }, (_, i) => [40.8 + i * 0.001, -73.9, `new-stop-${i}`])
      ),
    });
    const saved = await saveAmenityDataset("transit", updated);
    expect(saved).toBe(true);

    const docs = await db.collection(AMENITIES_COLLECTION).find({}).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0].subway.names[0]).toBe("new-stop-0");
  });

  it("saveAmenityDataset refuses a write that drops a bucket's point count by more than 30%", async () => {
    const big = transitFixture({
      subway: bucketFixture(
        Array.from({ length: 20 }, (_, i) => [40.7 + i * 0.001, -73.9, `stop-${i}`])
      ),
    });
    const db = await getDb();
    await db.collection(AMENITIES_COLLECTION).insertOne({ _id: "transit", ...big });

    const thin = transitFixture({
      subway: bucketFixture([[40.7, -73.9, "only-one"]]), // 1 of 20 — a 95% drop
    });
    const saved = await saveAmenityDataset("transit", thin);
    expect(saved).toBe(false);

    // The original, larger dataset must still be the one in Mongo.
    const doc = await db.collection(AMENITIES_COLLECTION).findOne({ _id: "transit" });
    expect(doc.subway.n).toBe(20);
  });

  it("saveAmenityDataset refuses an invalid document outright", async () => {
    const broken = transitFixture();
    delete broken.rail;
    const saved = await saveAmenityDataset("transit", broken);
    expect(saved).toBe(false);
  });
});
