import { describe, it, expect } from "vitest";
import {
  bandFor,
  percentileFor,
  bucketScore,
  scoreTier,
  buildReport,
} from "../src/services/scoring.js";
import {
  BAND_THRESHOLDS,
  BUCKET_NAMES,
  RADIUS_TIERS,
  CONFIDENCE,
  CONFIDENCE_REASONS,
  SCORE_ANCHOR_PERCENTILES,
} from "../src/config/constants.js";

// Pure functions against fixtures. No network, no Mongo, no clock.
//
// The fixture below is shaped like the real committed baseline (see
// src/config/baseline.json) but with round numbers, so an assertion that breaks
// points at the scoring maths rather than at a baseline rerun.

const BASELINE = {
  _id: "test",
  perBucket: {
    // building — heavily zero-inflated, which is what the real data looks like
    heatHotWater: { median: 2, p90: 100, zeroShare: 0.4 },
    unsanitaryCondition: { median: 1, p90: 25, zeroShare: 0.45 },
    plumbing: { median: 0, p90: 20, zeroShare: 0.5 },
    // block — never zero at 350m in NYC
    noise: { median: 1000, p90: 4000, zeroShare: 0 },
    parking: { median: 1000, p90: 2000, zeroShare: 0 },
    streetCondition: { median: 100, p90: 260, zeroShare: 0 },
  },
  radiusMeters: {
    building: RADIUS_TIERS.building.radiusMeters,
    block: RADIUS_TIERS.block.radiusMeters,
  },
};

const ZERO_BUILDING = { heatHotWater: 0, unsanitaryCondition: 0, plumbing: 0 };
const TYPICAL_BLOCK = { noise: 1000, parking: 1000, streetCondition: 100 };

describe("bandFor", () => {
  it("treats thresholds as inclusive lower bounds", () => {
    expect(bandFor(BAND_THRESHOLDS.good)).toBe("good");
    expect(bandFor(BAND_THRESHOLDS.good - 1)).toBe("fair");
    expect(bandFor(BAND_THRESHOLDS.fair)).toBe("fair");
    expect(bandFor(BAND_THRESHOLDS.fair - 1)).toBe("poor");
  });

  it("maps the ends of the scale", () => {
    // Direction matters: 100 = fewest complaints = good news for a renter.
    expect(bandFor(100)).toBe("good");
    expect(bandFor(0)).toBe("poor");
  });

  it("only ever returns a band the contract allows", () => {
    for (let score = 0; score <= 100; score++) {
      expect(["good", "fair", "poor"]).toContain(bandFor(score));
    }
  });

  it("is monotonic — a higher score never yields a worse band", () => {
    const rank = { poor: 0, fair: 1, good: 2 };
    let previous = 0;
    for (let score = 0; score <= 100; score++) {
      const current = rank[bandFor(score)];
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("percentileFor", () => {
  const noise = BASELINE.perBucket.noise;

  it("puts a count at the median on the median percentile", () => {
    expect(percentileFor(noise.median, noise)).toBe(
      SCORE_ANCHOR_PERCENTILES.median
    );
  });

  it("puts a count at p90 on the p90 percentile", () => {
    expect(percentileFor(noise.p90, noise)).toBe(SCORE_ANCHOR_PERCENTILES.p90);
  });

  it("puts zero at the bottom of the distribution", () => {
    for (const bucket of Object.values(BASELINE.perBucket)) {
      expect(percentileFor(0, bucket)).toBe(0);
    }
  });

  it("keeps climbing above p90 without exceeding 100", () => {
    const justOver = percentileFor(noise.p90 + 1, noise);
    expect(justOver).toBeGreaterThan(SCORE_ANCHOR_PERCENTILES.p90);
    expect(percentileFor(noise.p90 * 100, noise)).toBe(100);
    expect(percentileFor(Number.MAX_SAFE_INTEGER, noise)).toBeLessThanOrEqual(100);
  });

  it("is monotonically non-decreasing in the count", () => {
    // The property everything else rests on: more complaints must never map to
    // a better position in the distribution.
    for (const bucket of Object.values(BASELINE.perBucket)) {
      let previous = -1;
      for (const count of [0, 1, 2, 5, 10, 50, 100, 500, 1000, 5000, 20000]) {
        const current = percentileFor(count, bucket);
        expect(current).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    }
  });

  it("places the first complaint above the whole zero tie", () => {
    // 50% of the city has no plumbing complaints, so having one is worse than
    // half the city — NOT a fraction of the way to a median of zero.
    const plumbing = BASELINE.perBucket.plumbing;
    expect(percentileFor(1, plumbing)).toBeCloseTo(50, 5);
  });

  it("never lets a zero-median bucket score a zero count as average", () => {
    // Regression: with median 0, the zero anchor used to inherit the median's
    // 50th percentile, so a building with no plumbing complaints scored 50
    // instead of 100. Caught on a live mid-street coordinate, not in a unit test.
    expect(bucketScore(0, BASELINE.perBucket.plumbing)).toBe(100);
  });

  it("survives a baseline with no spread at all", () => {
    const degenerate = { median: 0, p90: 0, zeroShare: 0.99 };
    expect(percentileFor(0, degenerate)).toBe(0);
    expect(percentileFor(1, degenerate)).toBeGreaterThan(90);
    expect(percentileFor(1000, degenerate)).toBe(100);
  });

  it("survives a missing or malformed baseline entry", () => {
    for (const bad of [undefined, null, {}, { median: NaN, p90: "x" }]) {
      const value = percentileFor(5, bad);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe("bucketScore", () => {
  it("inverts the percentile — more complaints means a LOWER score", () => {
    const noise = BASELINE.perBucket.noise;
    expect(bucketScore(0, noise)).toBe(100);
    expect(bucketScore(noise.median, noise)).toBe(50);
    expect(bucketScore(noise.p90, noise)).toBe(10);
    expect(bucketScore(noise.p90 * 10, noise)).toBe(0);
  });

  it("stays inside 0-100 for absurd inputs", () => {
    for (const count of [-5, 0, 1e9, NaN, undefined]) {
      const score = bucketScore(count, BASELINE.perBucket.noise);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

describe("scoreTier", () => {
  it("averages the three bucket scores", () => {
    // parking at median (50), noise at p90 (10), streetCondition at 0 (100).
    const tier = scoreTier(
      "block",
      { noise: 4000, parking: 1000, streetCondition: 0 },
      BASELINE
    );
    expect(tier.bucketScores).toEqual({
      noise: 10,
      parking: 50,
      streetCondition: 100,
    });
    expect(tier.score).toBe(Math.round((10 + 50 + 100) / 3));
  });

  it("returns the frozen sub-score shape", () => {
    const tier = scoreTier("block", TYPICAL_BLOCK, BASELINE);
    expect(Object.keys(tier).sort()).toEqual([
      "band",
      "bucketConfidence",
      "bucketScores",
      "confidence",
      "confidenceReason",
      "counts",
      "radiusMeters",
      "score",
    ]);
    expect(tier.radiusMeters).toBe(RADIUS_TIERS.block.radiusMeters);
    expect(Object.keys(tier.counts).sort()).toEqual([...BUCKET_NAMES.block].sort());
    expect(Number.isInteger(tier.score)).toBe(true);
    expect(tier.band).toBe(bandFor(tier.score));
  });

  it("scores a typical block at the middle of the scale", () => {
    // Every bucket exactly at the citywide median must land on 50, or the
    // baseline is not actually centring the scale.
    expect(scoreTier("block", TYPICAL_BLOCK, BASELINE).score).toBe(50);
  });

  it("ranks a quiet block above a loud one", () => {
    const quiet = scoreTier(
      "block",
      { noise: 100, parking: 200, streetCondition: 10 },
      BASELINE
    );
    const loud = scoreTier(
      "block",
      { noise: 6000, parking: 5000, streetCondition: 400 },
      BASELINE
    );
    expect(quiet.score).toBeGreaterThan(loud.score);
    expect(quiet.band).toBe("good");
    expect(loud.band).toBe("poor");
  });

  it("flags an all-zero tier as low confidence", () => {
    // The dangerous failure mode: a mid-street coordinate finds no building
    // complaints and would otherwise be reported as a PERFECT building.
    const tier = scoreTier("building", ZERO_BUILDING, BASELINE);
    expect(tier.score).toBe(100);
    expect(tier.confidence).toBe(CONFIDENCE.low);
    expect(tier.confidenceReason).toBe(CONFIDENCE_REASONS.noComplaintsFound);
  });

  it("does not flag a tier that has any complaint at all", () => {
    const tier = scoreTier(
      "building",
      { ...ZERO_BUILDING, plumbing: 1 },
      BASELINE
    );
    expect(tier.confidence).toBe(CONFIDENCE.normal);
    expect(tier.confidenceReason).toBeNull();
  });

  it("marks streetCondition — and only streetCondition — as a weak bucket", () => {
    // 25.6% of Street Condition rows have no coordinates, and the nulls are not
    // uniform by borough, so the bucket cannot be presented as equally solid.
    expect(scoreTier("block", TYPICAL_BLOCK, BASELINE).bucketConfidence).toEqual({
      streetCondition: CONFIDENCE.low,
    });
    expect(scoreTier("building", { heatHotWater: 1 }, BASELINE).bucketConfidence).toEqual(
      {}
    );
  });

  it("flags a missing baseline instead of inventing a score", () => {
    const tier = scoreTier("block", TYPICAL_BLOCK, null);
    expect(tier.confidence).toBe(CONFIDENCE.low);
    expect(tier.confidenceReason).toBe(CONFIDENCE_REASONS.noBaseline);
    expect(Number.isInteger(tier.score)).toBe(true);
  });

  it("flags a baseline computed at a different radius", () => {
    // Retuning RADIUS_TIERS without rerunning buildBaseline silently shifts
    // every score. It must not pass unnoticed.
    const stale = {
      ...BASELINE,
      radiusMeters: { building: 25, block: 999 },
    };
    expect(scoreTier("block", TYPICAL_BLOCK, stale).confidenceReason).toBe(
      CONFIDENCE_REASONS.staleBaseline
    );
    expect(scoreTier("building", { heatHotWater: 1 }, stale).confidence).toBe(
      CONFIDENCE.normal
    );
  });

  it("treats a missing bucket as zero rather than propagating NaN", () => {
    // A partially-built payload must not poison the mean with NaN — the score
    // would render as "NaN" in the UI and nobody would know why.
    const tier = scoreTier("block", { noise: 1000 }, BASELINE);
    expect(Number.isInteger(tier.score)).toBe(true);
    expect(tier.counts).toEqual({ noise: 1000, parking: 0, streetCondition: 0 });
  });

  // bucketStatusCounts — pure pass-through, no scoring logic reads it.
  it("attaches bucketStatusCounts verbatim when provided", () => {
    const statusCounts = {
      noise: { open: 400, "in-progress": 100, closed: 500 },
      parking: { open: 200, "in-progress": 50, closed: 750 },
      streetCondition: { open: 10, "in-progress": 5, closed: 85 },
    };
    const tier = scoreTier("block", TYPICAL_BLOCK, BASELINE, statusCounts);
    expect(tier.bucketStatusCounts).toEqual(statusCounts);
    // Passing it must not change the score itself — it is purely descriptive.
    expect(tier.score).toBe(scoreTier("block", TYPICAL_BLOCK, BASELINE).score);
  });

  it("omits bucketStatusCounts entirely when not provided, rather than defaulting to zeros", () => {
    const tier = scoreTier("block", TYPICAL_BLOCK, BASELINE);
    expect(tier).not.toHaveProperty("bucketStatusCounts");
    // The existing frozen-shape assertion above must keep passing untouched.
    expect(Object.keys(tier).sort()).toEqual([
      "band",
      "bucketConfidence",
      "bucketScores",
      "confidence",
      "confidenceReason",
      "counts",
      "radiusMeters",
      "score",
    ]);
  });
});

describe("buildReport", () => {
  const counts = { building: ZERO_BUILDING, block: TYPICAL_BLOCK };

  it("returns the frozen top-level contract shape", () => {
    const report = buildReport(counts, BASELINE);
    expect(Object.keys(report).sort()).toEqual([
      "address",
      "blockQuality",
      "buildingHealth",
      "meta",
    ]);
    expect(report.address).toBeNull(); // we never geocode
    expect(report.buildingHealth.radiusMeters).toBe(
      RADIUS_TIERS.building.radiusMeters
    );
    expect(report.blockQuality.radiusMeters).toBe(RADIUS_TIERS.block.radiusMeters);
  });

  it("records which baseline produced the numbers", () => {
    const report = buildReport(counts, { ...BASELINE, source: "file" });
    expect(report.meta.baselineVersion).toBe("test");
    expect(report.meta.baselineSource).toBe("file");
    expect(report.meta.windowMonths).toBeGreaterThan(0);
  });

  it("passes extra meta through without overwriting the baseline fields", () => {
    const report = buildReport(counts, BASELINE, { cache: { block: "hit" } });
    expect(report.meta.cache).toEqual({ block: "hit" });
    expect(report.meta.baselineVersion).toBe("test");
  });

  it("is pure — same inputs, same output, no mutation", () => {
    const input = structuredClone(counts);
    const first = buildReport(input, BASELINE);
    const second = buildReport(input, BASELINE);
    expect(first).toEqual(second);
    expect(input).toEqual(counts);
  });

  it("survives no baseline at all", () => {
    const report = buildReport(counts, null);
    expect(report.buildingHealth.confidence).toBe(CONFIDENCE.low);
    expect(report.blockQuality.confidenceReason).toBe(
      CONFIDENCE_REASONS.noBaseline
    );
    expect(report.meta.baselineVersion).toBeNull();
  });

  it("threads per-tier statusCounts into each section as bucketStatusCounts", () => {
    const statusCounts = {
      building: {
        heatHotWater: { open: 0, "in-progress": 0, closed: 0 },
        unsanitaryCondition: { open: 0, "in-progress": 0, closed: 0 },
        plumbing: { open: 0, "in-progress": 0, closed: 0 },
      },
      block: {
        noise: { open: 300, "in-progress": 100, closed: 600 },
        parking: { open: 50, "in-progress": 50, closed: 900 },
        streetCondition: { open: 10, "in-progress": 10, closed: 80 },
      },
    };
    const report = buildReport(counts, BASELINE, {}, null, null, statusCounts);
    expect(report.buildingHealth.bucketStatusCounts).toEqual(statusCounts.building);
    expect(report.blockQuality.bucketStatusCounts).toEqual(statusCounts.block);
  });

  it("omits bucketStatusCounts from every section when statusCounts is not passed", () => {
    const report = buildReport(counts, BASELINE);
    expect(report.buildingHealth).not.toHaveProperty("bucketStatusCounts");
    expect(report.blockQuality).not.toHaveProperty("bucketStatusCounts");
  });
});

describe("scoring against the committed baseline", () => {
  // Guards the real artifact, not the fixture: if src/config/baseline.json is
  // rebuilt into something degenerate, these fail.
  it("centres real-world counts sensibly", async () => {
    const { readFile } = await import("node:fs/promises");
    const committed = JSON.parse(
      await readFile(new URL("../src/config/baseline.json", import.meta.url), "utf8")
    );

    for (const [tier, buckets] of Object.entries(BUCKET_NAMES)) {
      const atMedian = Object.fromEntries(
        buckets.map((bucket) => [bucket, committed.perBucket[bucket].median])
      );
      const atP90 = Object.fromEntries(
        buckets.map((bucket) => [bucket, committed.perBucket[bucket].p90])
      );
      const median = scoreTier(tier, atMedian, committed).score;
      const p90 = scoreTier(tier, atP90, committed).score;

      // This is the whole promise of scoring against a baseline: a location at
      // the citywide median must land in the middle of the scale ("fair"), and
      // one at p90 must land clearly worse. If a rebuilt baseline ever breaks
      // this, the scale has stopped being centred on NYC and the scores are
      // decoration.
      //
      // The building tier only satisfies this because each tier is sampled from
      // its OWN source — a pooled sample put street corners in the building
      // distribution and pushed the median to the "good" boundary.
      expect(median).toBeGreaterThanOrEqual(BAND_THRESHOLDS.fair);
      expect(median).toBeLessThan(BAND_THRESHOLDS.good);
      expect(p90).toBeLessThan(BAND_THRESHOLDS.fair);
      expect(p90).toBeLessThan(median);
    }
  });
});
