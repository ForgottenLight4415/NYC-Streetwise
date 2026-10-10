import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { startMongo } from "./helpers/mongoTestServer.js";
import { getDb } from "../src/providers/mongo.js";
import {
  loadBaseline,
  saveBaseline,
  isValidBaseline,
  resetBaselineMemo,
  BASELINE_FILE_PATH,
} from "../src/providers/baseline.js";
import {
  BASELINE_COLLECTION,
  BASELINE_ID,
  BUCKET_NAMES,
  RADIUS_TIERS,
} from "../src/config/constants.js";

const ALL_BUCKETS = Object.values(BUCKET_NAMES).flat();

function fixture(overrides = {}) {
  return {
    _id: BASELINE_ID,
    perBucket: Object.fromEntries(
      ALL_BUCKETS.map((bucket) => [bucket, { median: 5, p90: 50, zeroShare: 0.1 }])
    ),
    radiusMeters: { building: 25, block: 350 },
    sampleSize: 200,
    ...overrides,
  };
}

describe("isValidBaseline", () => {
  it("accepts a complete document", () => {
    expect(isValidBaseline(fixture())).toBe(true);
  });

  it.each([
    ["null", null],
    ["no perBucket", { _id: "v1" }],
    ["empty perBucket", { perBucket: {} }],
  ])("rejects %s", (_label, doc) => {
    expect(isValidBaseline(doc)).toBe(false);
  });

  it("rejects a document missing even one bucket", () => {
    // A half-baseline is worse than none: the missing bucket would score
    // against `undefined` and quietly hand out a free 100.
    const doc = fixture();
    delete doc.perBucket.plumbing;
    expect(isValidBaseline(doc)).toBe(false);
  });

  it.each([
    ["a non-numeric median", { median: "x", p90: 10 }],
    ["a NaN p90", { median: 1, p90: NaN }],
    ["a negative median", { median: -1, p90: 10 }],
  ])("rejects %s", (_label, entry) => {
    const doc = fixture();
    doc.perBucket.noise = entry;
    expect(isValidBaseline(doc)).toBe(false);
  });
});

describe("the committed baseline", () => {
  // This file is an artifact the API depends on at runtime — if it is broken or
  // missing, every score is served as low-confidence. It must stay committed.
  it("exists, is valid, and covers every bucket at the current radii", async () => {
    const doc = JSON.parse(await readFile(BASELINE_FILE_PATH, "utf8"));

    expect(isValidBaseline(doc)).toBe(true);
    expect(Object.keys(doc.perBucket).sort()).toEqual([...ALL_BUCKETS].sort());
    expect(doc.radiusMeters).toEqual({
      building: RADIUS_TIERS.building.radiusMeters,
      block: RADIUS_TIERS.block.radiusMeters,
    });
    // A baseline from a handful of points would look authoritative and be noise.
    expect(doc.sampleSize).toBeGreaterThanOrEqual(100);
  });

  it("records zeroShare, which the scorer reads", () => {
    // Not a diagnostic: anchorsFor() needs it to place the first complaint
    // above the zero tie on these heavily zero-inflated buckets.
    return readFile(BASELINE_FILE_PATH, "utf8").then((raw) => {
      for (const stats of Object.values(JSON.parse(raw).perBucket)) {
        expect(stats.zeroShare).toBeGreaterThanOrEqual(0);
        expect(stats.zeroShare).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe("loadBaseline without Mongo", () => {
  beforeEach(() => resetBaselineMemo());

  it("falls back to the committed file so a fresh clone still scores", async () => {
    const baseline = await loadBaseline();
    expect(baseline.source).toBe("file");
    expect(isValidBaseline(baseline)).toBe(true);
  });

  it("memoizes — the baseline only changes when the script is rerun", async () => {
    const first = await loadBaseline();
    const second = await loadBaseline();
    expect(second).toBe(first); // same object identity, not just equal
  });

});

describe("loadBaseline with Mongo", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startMongo();
  });

  afterAll(async () => {
    await mongo.stop();
    resetBaselineMemo();
  });

  beforeEach(async () => {
    resetBaselineMemo();
    const db = await getDb();
    await db.collection(BASELINE_COLLECTION).deleteMany({});
  });

  it("prefers Mongo, so the baseline can be refreshed without a redeploy", async () => {
    await saveBaseline(fixture({ sampleSize: 999 }));
    const baseline = await loadBaseline();
    expect(baseline.source).toBe("mongo");
    expect(baseline.sampleSize).toBe(999);
  });

  it("falls back to the committed file when Mongo has no document", async () => {
    expect((await loadBaseline()).source).toBe("file");
  });

  it("falls back to the committed file when the Mongo document is incomplete", async () => {
    const broken = fixture();
    delete broken.perBucket.noise;
    const db = await getDb();
    await db.collection(BASELINE_COLLECTION).insertOne(broken);

    const baseline = await loadBaseline();
    expect(baseline.source).toBe("file");
    expect(isValidBaseline(baseline)).toBe(true);
  });

  it("saveBaseline upserts rather than duplicating", async () => {
    await saveBaseline(fixture({ sampleSize: 100 }));
    await saveBaseline(fixture({ sampleSize: 250 }));

    const db = await getDb();
    const docs = await db.collection(BASELINE_COLLECTION).find({}).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]._id).toBe(BASELINE_ID);
    expect(docs[0].sampleSize).toBe(250);
  });
});
