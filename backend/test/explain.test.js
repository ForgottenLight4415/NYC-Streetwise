import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  templateExplanation,
  dominantBucket,
} from "../src/services/templateExplanation.js";
import { BUCKET_NAMES, AMENITY_TIERS, EXPLANATION_SOURCES } from "../src/config/constants.js";

// The fallback path is the one that must never break, so it gets the most
// hostile inputs. The AI provider is mocked — this file is about what happens
// AROUND the AI call, not the call itself (that is ai.test.js).

const { generateSpy } = vi.hoisted(() => ({ generateSpy: vi.fn() }));

vi.mock("../src/providers/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, generateExplanation: generateSpy };
});

const { explainFromTemplate, explanationInputFor, radiusLabelFor, TIER_LABELS } =
  await import("../src/services/explain.js");

const BUILDING = {
  band: "good",
  counts: { heatHotWater: 5, unsanitaryCondition: 0, plumbing: 1, repairs: 0, electricGas: 0, buildingSafety: 0 },
  bucketScores: { heatHotWater: 88, unsanitaryCondition: 100, plumbing: 86, repairs: 100, electricGas: 100, buildingSafety: 100 },
};

const BLOCK = {
  band: "poor",
  counts: { noise: 2876, parking: 1253, streetCondition: 144, sanitation: 0, infrastructure: 0, publicSafety: 0 },
  bucketScores: { noise: 18, parking: 46, streetCondition: 44, sanitation: 100, infrastructure: 100, publicSafety: 100 },
};

beforeEach(() => {
  generateSpy.mockReset();
  generateSpy.mockResolvedValue("An AI sentence about this block.");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("templateExplanation", () => {
  // templateExplanation states the dominant bucket with its real count and the tier total, as complete sentences.
  it("states the dominant bucket with its real count and the tier total", () => {
    const text = templateExplanation({ label: "Block Quality", ...BLOCK });
    // BLOCK's worst-scored bucket is noise (2876); the total is 2876 + 1253 + 144 = 4273.
    expect(text).toContain("Noise stands out with 2876 complaints");
    expect(text).toContain("out of 4273 total");
    expect(text).toMatch(/\.$/);
  });

  // templateExplanation words a good band differently from a poor band ("fewer" vs "more").
  it("reflects the band", () => {
    const good = templateExplanation({ label: "Block Quality", ...BLOCK, band: "good" });
    const poor = templateExplanation({ label: "Block Quality", ...BLOCK, band: "poor" });
    expect(good).toMatch(/fewer/i);
    expect(poor).toMatch(/more/i);
    expect(good).not.toBe(poor);
  });

  // templateExplanation names the dominant bucket in plain words ("heat and hot water"), never the camelCase key.
  it("names the dominant bucket in human words, never a camelCase key", () => {
    // heat (score 88, 5 complaints) and plumbing (86, 1) are within the tie
    // margin, so the larger count wins — "plumbing stands out with 1 complaint"
    // while heat had 5 is not what standing out means.
    const text = templateExplanation({ label: "Building Health", ...BUILDING });
    expect(text.toLowerCase()).toContain("heat and hot water");
    expect(text).not.toContain("heatHotWater");
  });

  // templateExplanation does not praise an all-zero complaint result, since it may be a coordinate that missed its building.
  it("does not congratulate a zero-complaint result", () => {
    // An all-zero building is also what a coordinate that missed its building
    // looks like. The response already carries confidence: "low"; the text must
    // not undercut that by calling it good news.
    const text = templateExplanation({
      label: "Building Health",
      band: "good",
      counts: { heatHotWater: 0, unsanitaryCondition: 0, plumbing: 0, repairs: 0, electricGas: 0, buildingSafety: 0 },
    });
    expect(text).toMatch(/no 311 complaints were filed/i);
    expect(text).not.toMatch(/excellent|great|perfect|well maintained/i);
  });

  // templateExplanation returns a non-empty string without throwing on missing counts, empty counts, an unknown band or label, or no arguments.
  it.each([
    ["no counts", { label: "Block Quality", band: "good" }],
    ["empty counts", { label: "Block Quality", band: "good", counts: {} }],
    ["unknown band", { label: "Block Quality", band: "???", counts: { noise: 5 } }],
    ["unknown label", { label: "Nonsense", band: "fair", counts: { noise: 5 } }],
    ["no arguments at all", {}],
  ])("survives %s — it is the fallback, it cannot throw", (_label, input) => {
    const text = templateExplanation(input);
    expect(text).toBeTypeOf("string");
    expect(text.length).toBeGreaterThan(0);
  });

  // templateExplanation uses "1 complaint" for singular and "complaints" for plural.
  it("uses singular/plural correctly", () => {
    const one = templateExplanation({
      label: "Building Health",
      band: "good",
      counts: { heatHotWater: 1, unsanitaryCondition: 0, plumbing: 0, repairs: 0, electricGas: 0, buildingSafety: 0 },
    });
    // Word boundary matters: the opener contains "311 complaints", which a
    // naive /1 complaints/ would match.
    expect(one).toMatch(/\b1 complaint\b/);
    expect(one).not.toMatch(/\b1 complaints\b/);
  });
});

describe("dominantBucket", () => {
  // dominantBucket picks the bucket with the worst score rather than the largest raw count.
  it("prefers the worst SCORE over the largest raw count", () => {
    // Raw counts are not comparable across buckets: 144 street-condition
    // complaints can matter more than 2876 noise ones, because the citywide
    // norms differ by an order of magnitude.
    const bucket = dominantBucket({
      counts: { noise: 2876, parking: 1253, streetCondition: 144, sanitation: 0, infrastructure: 0, publicSafety: 0 },
      bucketScores: { noise: 80, parking: 90, streetCondition: 5, sanitation: 100, infrastructure: 100, publicSafety: 100 },
    });
    expect(bucket).toBe("streetCondition");
  });

  // dominantBucket falls back to the largest raw count when bucket scores are absent.
  it("falls back to the largest count when scores are absent", () => {
    expect(dominantBucket({ counts: { noise: 10, parking: 99 } })).toBe("parking");
  });

  // dominantBucket returns null when counts are empty.
  it("returns null for empty counts", () => {
    expect(dominantBucket({ counts: {} })).toBeNull();
  });
});

describe("explainFromTemplate", () => {
  // explainFromTemplate labels its source as the template source and never calls the AI provider.
  it("labels its source honestly and never calls the AI", () => {
    const result = explainFromTemplate("block", BLOCK);
    expect(result.explanationSource).toBe(EXPLANATION_SOURCES.template);
    expect(result.explanation).toBeTypeOf("string");
    expect(generateSpy).not.toHaveBeenCalled();
  });
});

describe("tier labelling", () => {
  // radiusLabelFor describes the building (80 ft) and block (0.2 mi) radii and still returns a string for an unknown tier.
  it("describes each tier's real radius", () => {
    expect(radiusLabelFor("building")).toContain("80 ft");
    expect(radiusLabelFor("block")).toContain("0.2 mi");
    expect(radiusLabelFor("nonsense")).toBeTypeOf("string");
  });

  // explanationInputFor gives every complaint and amenity tier a capitalised human label, never the raw tier key.
  it("covers every tier the API scores", () => {
    for (const tier of [...Object.keys(BUCKET_NAMES), ...Object.keys(AMENITY_TIERS)]) {
      const input = explanationInputFor(tier, { band: "fair", counts: {}, metrics: {} });
      expect(TIER_LABELS, tier).toHaveProperty(tier);
      expect(input.label).toBe(TIER_LABELS[tier]);
      expect(input.label).not.toBe(tier); // a human name, not the key
      expect(input.label).toMatch(/^[A-Z]/);
    }
  });
});
