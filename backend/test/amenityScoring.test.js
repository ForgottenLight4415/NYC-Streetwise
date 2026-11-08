import { describe, it, expect } from "vitest";
import { scoreAmenityTier, amenityBandFor, buildReport } from "../src/services/scoring.js";
import {
  AMENITY_TIERS,
  AMENITY_MAX_METERS,
  AMENITY_BAND_THRESHOLDS,
  CONFIDENCE,
  CONFIDENCE_REASONS,
} from "../src/config/constants.js";

// Fixture shaped like the real committed amenityBaseline.json, round numbers
// so an assertion breaking points at the scoring maths, not a baseline rerun.
const AMENITY_BASELINE = {
  _id: "test",
  perBucket: {
    subway: { median: 300, p90: 1200, zeroShare: 0 },
    bus: { median: 120, p90: 550, zeroShare: 0 },
    rail: { median: 1600, p90: 2000, zeroShare: 0 },
    park: { median: 340, p90: 760, zeroShare: 0 },
    playground: { median: 500, p90: 970, zeroShare: 0 },
    garden: { median: 900, p90: 2000, zeroShare: 0 },
    bikeShare: { median: 210, p90: 2000, zeroShare: 0 },
    bikeLane: { median: 120, p90: 850, zeroShare: 0 },
    protectedLane: { median: 330, p90: 1200, zeroShare: 0 },
  },
};

function metric(meters, within = 1, name = "Some Place") {
  return { meters, within, name };
}

const TYPICAL_TRANSIT = {
  subway: metric(300),
  bus: metric(120),
  rail: metric(1600),
};

describe("scoreAmenityTier", () => {
  // scoreAmenityTier scores 0m distance as 100 for every bucket, like zero complaints.
  it("scores 0m as 100, exactly as 0 complaints does", () => {
    const tier = scoreAmenityTier(
      "transit",
      { subway: metric(0), bus: metric(0), rail: metric(0) },
      AMENITY_BASELINE
    );
    expect(tier.bucketScores).toEqual({ subway: 100, bus: 100, rail: 100 });
    expect(tier.score).toBe(100);
  });

  // scoreAmenityTier scores a distance equal to the baseline median as 50.
  it("scores the median distance as 50", () => {
    const tier = scoreAmenityTier("transit", TYPICAL_TRANSIT, AMENITY_BASELINE);
    expect(tier.bucketScores.subway).toBe(50);
    expect(tier.bucketScores.bus).toBe(50);
    expect(tier.bucketScores.rail).toBe(50);
  });

  // scoreAmenityTier scores a null distance the same as the AMENITY_MAX_METERS cap, not as zero.
  it("scores a null distance as the cap, not as zero", () => {
    const withNull = scoreAmenityTier(
      "transit",
      { subway: metric(null, 0, null), bus: metric(120), rail: metric(1600) },
      AMENITY_BASELINE
    );
    const capped = scoreAmenityTier(
      "transit",
      { subway: metric(AMENITY_MAX_METERS), bus: metric(120), rail: metric(1600) },
      AMENITY_BASELINE
    );
    expect(withNull.bucketScores.subway).toBe(capped.bucketScores.subway);
  });

  // scoreAmenityTier marks only a null-distance bucket low-confidence while the tier stays normal if the other buckets have data.
  it("flags a null-distance bucket low-confidence, but not the whole tier if only one bucket is null", () => {
    const tier = scoreAmenityTier(
      "transit",
      { subway: metric(null, 0, null), bus: metric(120), rail: metric(1600) },
      AMENITY_BASELINE
    );
    expect(tier.bucketConfidence).toEqual({ subway: CONFIDENCE.low });
    expect(tier.confidence).toBe(CONFIDENCE.normal);
  });

  // scoreAmenityTier marks the whole tier low-confidence (noneNearby) with very low scores when every bucket is null.
  it("flags the whole tier low-confidence when every bucket is null (e.g. Staten Island subway access)", () => {
    const tier = scoreAmenityTier(
      "transit",
      {
        subway: metric(null, 0, null),
        bus: metric(null, 0, null),
        rail: metric(null, 0, null),
      },
      AMENITY_BASELINE
    );
    expect(tier.confidence).toBe(CONFIDENCE.low);
    expect(tier.confidenceReason).toBe(CONFIDENCE_REASONS.noneNearby);
    // Every bucket capped, so every bucket also scores low.
    expect(Object.values(tier.bucketScores).every((s) => s <= 20)).toBe(true);
  });

  // scoreAmenityTier marks the tier low-confidence with the noBaseline reason when no baseline is supplied.
  it("flags low-confidence with no_baseline when no baseline is available", () => {
    const tier = scoreAmenityTier("transit", TYPICAL_TRANSIT, null);
    expect(tier.confidence).toBe(CONFIDENCE.low);
    expect(tier.confidenceReason).toBe(CONFIDENCE_REASONS.noBaseline);
  });

  // scoreAmenityTier weights subway 2x, so a maximally bad subway lowers the tier score more than an equally bad bus.
  it("weights subway 2x, so a bad subway score pulls the tier average down more than an equally bad bus score", () => {
    const badSubway = scoreAmenityTier(
      "transit",
      { subway: metric(AMENITY_MAX_METERS), bus: metric(0), rail: metric(0) },
      AMENITY_BASELINE
    );
    const badBus = scoreAmenityTier(
      "transit",
      { subway: metric(0), bus: metric(AMENITY_MAX_METERS), rail: metric(0) },
      AMENITY_BASELINE
    );
    expect(badSubway.score).toBeLessThan(badBus.score);
  });

  // scoreAmenityTier returns the sub-score shape with `metrics` (not `counts`) and the tier's radiusMeters.
  it("returns the frozen sub-score shape, with `metrics` in place of `counts`", () => {
    const tier = scoreAmenityTier("transit", TYPICAL_TRANSIT, AMENITY_BASELINE);
    expect(Object.keys(tier).sort()).toEqual(
      ["band", "bucketConfidence", "bucketScores", "confidence", "confidenceReason", "metrics", "radiusMeters", "score"].sort()
    );
    expect(tier.radiusMeters).toBe(AMENITY_TIERS.transit.radiusMeters);
  });

  // scoreAmenityTier fills in a missing bucket with an empty metric instead of producing NaN.
  it("fills in a missing bucket rather than producing NaN", () => {
    const tier = scoreAmenityTier("transit", { subway: metric(300) }, AMENITY_BASELINE);
    expect(tier.metrics.bus).toEqual({ meters: null, within: 0, name: null, routes: [] });
    expect(Number.isFinite(tier.score)).toBe(true);
  });

  // scoreAmenityTier drops an absent rail bucket from the weighted average when subway or bus is present, rather than counting it at the cap.
  it("excludes an absent rail bucket from the tier average once subway or bus is present", () => {
    const noRail = scoreAmenityTier(
      "transit",
      { subway: metric(320), bus: metric(160), rail: metric(null, 0, null) },
      AMENITY_BASELINE
    );
    // A missing rail station is dropped, not merely capped — the average
    // depends only on subway (weight 2) and bus (weight 1).
    const expected = Math.round(
      (noRail.bucketScores.subway * 2 + noRail.bucketScores.bus * 1) / 3
    );
    expect(noRail.score).toBe(expected);

    const railAtCap = scoreAmenityTier(
      "transit",
      { subway: metric(320), bus: metric(160), rail: metric(AMENITY_MAX_METERS) },
      AMENITY_BASELINE
    );
    expect(noRail.score).toBeGreaterThan(railAtCap.score);
  });

  // amenityBandFor maps scores to excellent/typical/carDependent at the threshold boundaries, and scoreAmenityTier uses that band.
  it("bands an amenity score on its own excellent/typical/carDependent scale, not good/fair/poor", () => {
    expect(amenityBandFor(AMENITY_BAND_THRESHOLDS.excellent)).toBe("excellent");
    expect(amenityBandFor(AMENITY_BAND_THRESHOLDS.excellent - 1)).toBe("typical");
    expect(amenityBandFor(AMENITY_BAND_THRESHOLDS.typical)).toBe("typical");
    expect(amenityBandFor(AMENITY_BAND_THRESHOLDS.typical - 1)).toBe("carDependent");
    expect(amenityBandFor(0)).toBe("carDependent");
    expect(amenityBandFor(100)).toBe("excellent");

    const tier = scoreAmenityTier("transit", TYPICAL_TRANSIT, AMENITY_BASELINE);
    expect(tier.band).toBe(amenityBandFor(tier.score));
    expect(["excellent", "typical", "carDependent"]).toContain(tier.band);
  });

  // scoreAmenityTier keeps rail in the weighted average when subway, bus and rail are all absent (a transit desert).
  it("keeps rail in the average when subway and bus are both absent too (a real transit desert)", () => {
    const desert = scoreAmenityTier(
      "transit",
      { subway: metric(null, 0, null), bus: metric(null, 0, null), rail: metric(null, 0, null) },
      AMENITY_BASELINE
    );
    const expected = Math.round(
      (desert.bucketScores.subway * 2 + desert.bucketScores.bus * 1 + desert.bucketScores.rail * 1) / 4
    );
    expect(desert.score).toBe(expected);
  });
});

describe("buildReport amenity integration", () => {
  const COUNTS = { building: { heatHotWater: 0, unsanitaryCondition: 0, plumbing: 0, repairs: 0, electricGas: 0, buildingSafety: 0 }, block: {} };
  const COMPLAINT_BASELINE = null; // irrelevant to these assertions

  // buildReport omits transitAccess, parksAccess and bikeAccess when amenities is null, leaving the complaint sections intact.
  it("omits all three amenity keys when amenities is null", () => {
    const report = buildReport(COUNTS, COMPLAINT_BASELINE, {}, null, AMENITY_BASELINE);
    expect(report).not.toHaveProperty("transitAccess");
    expect(report).not.toHaveProperty("parksAccess");
    expect(report).not.toHaveProperty("bikeAccess");
    // Existing shape untouched.
    expect(report).toHaveProperty("buildingHealth");
    expect(report).toHaveProperty("blockQuality");
  });

  // buildReport includes only the amenity sections whose tier data is present.
  it("includes only the tiers whose dataset loaded", () => {
    const report = buildReport(
      COUNTS,
      COMPLAINT_BASELINE,
      {},
      { transit: TYPICAL_TRANSIT, parks: null, bike: null },
      AMENITY_BASELINE
    );
    expect(report).toHaveProperty("transitAccess");
    expect(report).not.toHaveProperty("parksAccess");
    expect(report).not.toHaveProperty("bikeAccess");
  });

});
