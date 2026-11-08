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
    repairs: { median: 1, p90: 30, zeroShare: 0.45 },
    electricGas: { median: 0, p90: 15, zeroShare: 0.55 },
    buildingSafety: { median: 0, p90: 5, zeroShare: 0.7 },
    // block — never zero at 350m in NYC
    noise: { median: 1000, p90: 4000, zeroShare: 0 },
    parking: { median: 1000, p90: 2000, zeroShare: 0 },
    streetCondition: { median: 100, p90: 260, zeroShare: 0 },
    sanitation: { median: 100, p90: 400, zeroShare: 0 },
    infrastructure: { median: 50, p90: 200, zeroShare: 0 },
    publicSafety: { median: 20, p90: 300, zeroShare: 0 },
  },
  radiusMeters: {
    building: RADIUS_TIERS.building.radiusMeters,
    block: RADIUS_TIERS.block.radiusMeters,
  },
};

const ZERO_BUILDING = { heatHotWater: 0, unsanitaryCondition: 0, plumbing: 0, repairs: 0, electricGas: 0, buildingSafety: 0 };
const TYPICAL_BLOCK = { noise: 1000, parking: 1000, streetCondition: 100, sanitation: 100, infrastructure: 50, publicSafety: 20 };

describe("bandFor", () => {
  // bandFor treats the good and fair thresholds as inclusive lower bounds.
  it("treats thresholds as inclusive lower bounds", () => {
    expect(bandFor(BAND_THRESHOLDS.good)).toBe("good");
    expect(bandFor(BAND_THRESHOLDS.good - 1)).toBe("fair");
    expect(bandFor(BAND_THRESHOLDS.fair)).toBe("fair");
    expect(bandFor(BAND_THRESHOLDS.fair - 1)).toBe("poor");
  });

  // bandFor never gives a worse band for a higher score across 0-100.
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

  // percentileFor puts a count equal to the median at the median anchor percentile.
  it("puts a count at the median on the median percentile", () => {
    expect(percentileFor(noise.median, noise)).toBe(
      SCORE_ANCHOR_PERCENTILES.median
    );
  });

  // percentileFor puts a count equal to p90 at the p90 anchor percentile.
  it("puts a count at p90 on the p90 percentile", () => {
    expect(percentileFor(noise.p90, noise)).toBe(SCORE_ANCHOR_PERCENTILES.p90);
  });

  // percentileFor returns 0 for a zero count in every bucket.
  it("puts zero at the bottom of the distribution", () => {
    for (const bucket of Object.values(BASELINE.perBucket)) {
      expect(percentileFor(0, bucket)).toBe(0);
    }
  });

  // percentileFor keeps rising above p90, reaches 100 for very large counts and never exceeds 100.
  it("keeps climbing above p90 without exceeding 100", () => {
    const justOver = percentileFor(noise.p90 + 1, noise);
    expect(justOver).toBeGreaterThan(SCORE_ANCHOR_PERCENTILES.p90);
    expect(percentileFor(noise.p90 * 100, noise)).toBe(100);
    expect(percentileFor(Number.MAX_SAFE_INTEGER, noise)).toBeLessThanOrEqual(100);
  });

  // percentileFor never decreases as the count increases, for every bucket.
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

  // percentileFor puts a first complaint above the zero-count tie (about 50 for plumbing with a 50% zero share).
  it("places the first complaint above the whole zero tie", () => {
    // 50% of the city has no plumbing complaints, so having one is worse than
    // half the city — NOT a fraction of the way to a median of zero.
    const plumbing = BASELINE.perBucket.plumbing;
    expect(percentileFor(1, plumbing)).toBeCloseTo(50, 5);
  });

  // bucketScore gives a zero count in a zero-median bucket a score of 100, not 50.
  it("never lets a zero-median bucket score a zero count as average", () => {
    // Regression: with median 0, the zero anchor used to inherit the median's
    // 50th percentile, so a building with no plumbing complaints scored 50
    // instead of 100. Caught on a live mid-street coordinate, not in a unit test.
    expect(bucketScore(0, BASELINE.perBucket.plumbing)).toBe(100);
  });

  // percentileFor handles a baseline with median and p90 of 0 without NaN, scoring larger counts higher.
  it("survives a baseline with no spread at all", () => {
    const degenerate = { median: 0, p90: 0, zeroShare: 0.99 };
    expect(percentileFor(0, degenerate)).toBe(0);
    expect(percentileFor(1, degenerate)).toBeGreaterThan(90);
    expect(percentileFor(1000, degenerate)).toBe(100);
  });

  // percentileFor returns a finite 0-100 value for undefined, null, empty or malformed baseline entries.
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
  // bucketScore inverts the percentile: 100 at zero, 50 at the median, 10 at p90, 0 far above.
  it("inverts the percentile — more complaints means a LOWER score", () => {
    const noise = BASELINE.perBucket.noise;
    expect(bucketScore(0, noise)).toBe(100);
    expect(bucketScore(noise.median, noise)).toBe(50);
    expect(bucketScore(noise.p90, noise)).toBe(10);
    expect(bucketScore(noise.p90 * 10, noise)).toBe(0);
  });

  // bucketScore stays within 0-100 for negative, huge, NaN and undefined counts.
  it("stays inside 0-100 for absurd inputs", () => {
    for (const count of [-5, 0, 1e9, NaN, undefined]) {
      const score = bucketScore(count, BASELINE.perBucket.noise);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

describe("scoreTier", () => {
  // scoreTier sets each bucket score from its anchor and averages them into the tier score.
  it("averages the tier's bucket scores", () => {
    // Each bucket pinned to a known anchor: p90 (10), median (50) or 0 (100).
    const tier = scoreTier(
      "block",
      { noise: 4000, parking: 1000, streetCondition: 0, sanitation: 0, infrastructure: 50, publicSafety: 300 },
      BASELINE
    );
    expect(tier.bucketScores).toEqual({
      noise: 10,
      parking: 50,
      streetCondition: 100,
      sanitation: 100,
      infrastructure: 50,
      publicSafety: 10,
    });
    expect(tier.score).toBe(Math.round((10 + 50 + 100 + 100 + 50 + 10) / 6));
  });

  // scoreTier returns the frozen sub-score shape (no bucketStatusCounts unless provided) with counts, radiusMeters, an integer score and a matching band.
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
    // Omitted entirely when not provided, rather than defaulting to zeros.
    expect(tier).not.toHaveProperty("bucketStatusCounts");
    expect(tier.radiusMeters).toBe(RADIUS_TIERS.block.radiusMeters);
    expect(Object.keys(tier.counts).sort()).toEqual([...BUCKET_NAMES.block].sort());
    expect(Number.isInteger(tier.score)).toBe(true);
    expect(tier.band).toBe(bandFor(tier.score));
  });

  // scoreTier scores a block with every bucket at the citywide median as exactly 50.
  it("scores a typical block at the middle of the scale", () => {
    // Every bucket exactly at the citywide median must land on 50, or the
    // baseline is not actually centring the scale.
    expect(scoreTier("block", TYPICAL_BLOCK, BASELINE).score).toBe(50);
  });

  // scoreTier ranks a quiet block above a loud one, banding them good and poor.
  it("ranks a quiet block above a loud one", () => {
    const quiet = scoreTier(
      "block",
      { noise: 100, parking: 200, streetCondition: 10, sanitation: 10, infrastructure: 5, publicSafety: 0 },
      BASELINE
    );
    const loud = scoreTier(
      "block",
      { noise: 6000, parking: 5000, streetCondition: 400, sanitation: 900, infrastructure: 500, publicSafety: 800 },
      BASELINE
    );
    expect(quiet.score).toBeGreaterThan(loud.score);
    expect(quiet.band).toBe("good");
    expect(loud.band).toBe("poor");
  });

  // scoreTier scores an all-zero building 100 but flags it low confidence with the noComplaintsFound reason.
  it("flags an all-zero tier as low confidence", () => {
    // The dangerous failure mode: a mid-street coordinate finds no building
    // complaints and would otherwise be reported as a PERFECT building.
    const tier = scoreTier("building", ZERO_BUILDING, BASELINE);
    expect(tier.score).toBe(100);
    expect(tier.confidence).toBe(CONFIDENCE.low);
    expect(tier.confidenceReason).toBe(CONFIDENCE_REASONS.noComplaintsFound);
  });

  // scoreTier gives normal confidence and no reason to a tier with at least one complaint.
  it("does not flag a tier that has any complaint at all", () => {
    const tier = scoreTier(
      "building",
      { ...ZERO_BUILDING, plumbing: 1 },
      BASELINE
    );
    expect(tier.confidence).toBe(CONFIDENCE.normal);
    expect(tier.confidenceReason).toBeNull();
  });

  // scoreTier flags streetCondition, and only streetCondition, as a low-confidence bucket.
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

  // scoreTier flags low confidence with the noBaseline reason when no baseline is supplied, still returning an integer score.
  it("flags a missing baseline instead of inventing a score", () => {
    const tier = scoreTier("block", TYPICAL_BLOCK, null);
    expect(tier.confidence).toBe(CONFIDENCE.low);
    expect(tier.confidenceReason).toBe(CONFIDENCE_REASONS.noBaseline);
    expect(Number.isInteger(tier.score)).toBe(true);
  });

  // scoreTier flags the staleBaseline reason when the baseline radius differs for that tier, leaving the matching tier normal.
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

  // scoreTier treats missing buckets as 0 rather than producing NaN.
  it("treats a missing bucket as zero rather than propagating NaN", () => {
    // A partially-built payload must not poison the mean with NaN — the score
    // would render as "NaN" in the UI and nobody would know why.
    const tier = scoreTier("block", { noise: 1000 }, BASELINE);
    expect(Number.isInteger(tier.score)).toBe(true);
    expect(tier.counts).toEqual({ noise: 1000, parking: 0, streetCondition: 0, sanitation: 0, infrastructure: 0, publicSafety: 0 });
  });

  // bucketStatusCounts — pure pass-through, no scoring logic reads it.
  // scoreTier attaches bucketStatusCounts unchanged when provided, without changing the score.
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
});

describe("buildReport", () => {
  const counts = { building: ZERO_BUILDING, block: TYPICAL_BLOCK };

  // buildReport returns the frozen top-level shape with a null address and the correct tier radii.
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

  // buildReport records baseline version, baseline source and window months in meta.
  it("records which baseline produced the numbers", () => {
    const report = buildReport(counts, { ...BASELINE, source: "file" });
    expect(report.meta.baselineVersion).toBe("test");
    expect(report.meta.baselineSource).toBe("file");
    expect(report.meta.windowMonths).toBeGreaterThan(0);
  });

  // buildReport merges extra meta without overwriting the baseline fields.
  it("passes extra meta through without overwriting the baseline fields", () => {
    const report = buildReport(counts, BASELINE, { cache: { block: "hit" } });
    expect(report.meta.cache).toEqual({ block: "hit" });
    expect(report.meta.baselineVersion).toBe("test");
  });

  // buildReport is pure: identical inputs give identical outputs and the input is not mutated.
  it("is pure — same inputs, same output, no mutation", () => {
    const input = structuredClone(counts);
    const first = buildReport(input, BASELINE);
    const second = buildReport(input, BASELINE);
    expect(first).toEqual(second);
    expect(input).toEqual(counts);
  });

  // buildReport still builds, flagged low confidence with noBaseline, when the baseline is null.
  it("survives no baseline at all", () => {
    const report = buildReport(counts, null);
    expect(report.buildingHealth.confidence).toBe(CONFIDENCE.low);
    expect(report.blockQuality.confidenceReason).toBe(
      CONFIDENCE_REASONS.noBaseline
    );
    expect(report.meta.baselineVersion).toBeNull();
  });

  // buildReport passes each tier's statusCounts into its section as bucketStatusCounts.
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

  // buildReport omits bucketStatusCounts from both sections when statusCounts is not passed.
  it("omits bucketStatusCounts from every section when statusCounts is not passed", () => {
    const report = buildReport(counts, BASELINE);
    expect(report.buildingHealth).not.toHaveProperty("bucketStatusCounts");
    expect(report.blockQuality).not.toHaveProperty("bucketStatusCounts");
  });
});

describe("scoring against the committed baseline", () => {
  // Guards the real artifact, not the fixture: if src/config/baseline.json is
  // rebuilt into something degenerate, these fail.
  // Against the real committed baseline, counts at the citywide median score "fair" and counts at p90 score below fair and below the median score, for each tier.
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
