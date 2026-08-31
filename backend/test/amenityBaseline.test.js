import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startMongo } from "./helpers/mongoTestServer.js";
import { getDb } from "../src/providers/mongo.js";
import {
  loadAmenityBaseline,
  saveAmenityBaseline,
  isValidAmenityBaseline,
  resetAmenityBaselineMemo,
} from "../src/providers/amenityBaseline.js";
import {
  AMENITY_BASELINE_COLLECTION,
  AMENITY_BASELINE_ID,
  AMENITY_BUCKET_NAMES,
} from "../src/config/constants.js";

const ALL_AMENITY_BUCKETS = Object.values(AMENITY_BUCKET_NAMES).flat();

function fixture(overrides = {}) {
  return {
    _id: AMENITY_BASELINE_ID,
    perBucket: Object.fromEntries(
      ALL_AMENITY_BUCKETS.map((bucket) => [bucket, { median: 300, p90: 1200, zeroShare: 0.02 }])
    ),
    sampleSize: 120,
    ...overrides,
  };
}

describe("isValidAmenityBaseline", () => {
  it("accepts a complete document", () => {
    expect(isValidAmenityBaseline(fixture())).toBe(true);
  });

  it.each([
    ["null", null],
    ["no perBucket", { _id: "v1" }],
    ["empty perBucket", { perBucket: {} }],
  ])("rejects %s", (_label, doc) => {
    expect(isValidAmenityBaseline(doc)).toBe(false);
  });

  it("rejects a document missing even one bucket", () => {
    const doc = fixture();
    delete doc.perBucket.subway;
    expect(isValidAmenityBaseline(doc)).toBe(false);
  });

  it.each([
    ["a non-numeric median", { median: "x", p90: 10 }],
    ["a NaN p90", { median: 1, p90: NaN }],
    ["a negative median", { median: -1, p90: 10 }],
  ])("rejects %s", (_label, entry) => {
    const doc = fixture();
    doc.perBucket.bikeShare = entry;
    expect(isValidAmenityBaseline(doc)).toBe(false);
  });
});

describe("loadAmenityBaseline without Mongo", () => {
  beforeEach(() => resetAmenityBaselineMemo());

  it("falls back to the committed file so a fresh clone still scores", async () => {
    const baseline = await loadAmenityBaseline();
    expect(baseline.source).toBe("file");
    expect(isValidAmenityBaseline(baseline)).toBe(true);
  });

  it("memoizes — the baseline only changes when the script is rerun", async () => {
    const first = await loadAmenityBaseline();
    const second = await loadAmenityBaseline();
    expect(second).toBe(first);
  });

  it("forceRefresh re-reads", async () => {
    const first = await loadAmenityBaseline();
    const second = await loadAmenityBaseline({ forceRefresh: true });
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe("loadAmenityBaseline with Mongo", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startMongo();
  });

  afterAll(async () => {
    await mongo.stop();
    resetAmenityBaselineMemo();
  });

  beforeEach(async () => {
    resetAmenityBaselineMemo();
    const db = await getDb();
    await db.collection(AMENITY_BASELINE_COLLECTION).deleteMany({});
  });

  it("prefers Mongo, so the baseline can be refreshed without a redeploy", async () => {
    await saveAmenityBaseline(fixture({ sampleSize: 999 }));
    const baseline = await loadAmenityBaseline();
    expect(baseline.source).toBe("mongo");
    expect(baseline.sampleSize).toBe(999);
  });

  it("falls back to the committed file when Mongo has no document", async () => {
    expect((await loadAmenityBaseline()).source).toBe("file");
  });

  it("falls back to the committed file when the Mongo document is incomplete", async () => {
    const broken = fixture();
    delete broken.perBucket.park;
    const db = await getDb();
    await db.collection(AMENITY_BASELINE_COLLECTION).insertOne(broken);

    const baseline = await loadAmenityBaseline();
    expect(baseline.source).toBe("file");
    expect(isValidAmenityBaseline(baseline)).toBe(true);
  });

  it("saveAmenityBaseline upserts rather than duplicating", async () => {
    await saveAmenityBaseline(fixture({ sampleSize: 100 }));
    await saveAmenityBaseline(fixture({ sampleSize: 250 }));

    const db = await getDb();
    const docs = await db.collection(AMENITY_BASELINE_COLLECTION).find({}).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]._id).toBe(AMENITY_BASELINE_ID);
    expect(docs[0].sampleSize).toBe(250);
  });
});
