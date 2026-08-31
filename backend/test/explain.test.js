import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  templateExplanation,
  dominantBucket,
} from "../src/services/templateExplanation.js";
import { BUCKET_NAMES, EXPLANATION_SOURCES } from "../src/config/constants.js";

// The fallback path is the one that must never break, so it gets the most
// hostile inputs. The AI provider is mocked — this file is about what happens
// AROUND the AI call, not the call itself (that is ai.test.js).

const { generateSpy } = vi.hoisted(() => ({ generateSpy: vi.fn() }));

vi.mock("../src/providers/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, generateExplanation: generateSpy };
});

const { explainFromTemplate, explanationInputFor, radiusLabelFor } =
  await import("../src/services/explain.js");

const BUILDING = {
  band: "good",
  counts: { heatHotWater: 5, unsanitaryCondition: 0, plumbing: 1 },
  bucketScores: { heatHotWater: 88, unsanitaryCondition: 100, plumbing: 86 },
};

const BLOCK = {
  band: "poor",
  counts: { noise: 2876, parking: 1253, streetCondition: 144 },
  bucketScores: { noise: 18, parking: 46, streetCondition: 44 },
};

beforeEach(() => {
  generateSpy.mockReset();
  generateSpy.mockResolvedValue("An AI sentence about this block.");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("templateExplanation", () => {
  it("always returns a non-empty sentence", () => {
    const text = templateExplanation({ label: "Block Quality", ...BLOCK });
    expect(text).toBeTypeOf("string");
    expect(text.length).toBeGreaterThan(20);
  });

  it("is deterministic — the same input gives the same text", () => {
    const once = templateExplanation({ label: "Block Quality", ...BLOCK });
    const twice = templateExplanation({ label: "Block Quality", ...BLOCK });
    expect(once).toBe(twice);
  });

  it("reflects the band", () => {
    const good = templateExplanation({ label: "Block Quality", ...BLOCK, band: "good" });
    const poor = templateExplanation({ label: "Block Quality", ...BLOCK, band: "poor" });
    expect(good).toMatch(/fewer/i);
    expect(poor).toMatch(/more/i);
    expect(good).not.toBe(poor);
  });

  it("names the dominant bucket in human words, never a camelCase key", () => {
    // heat (score 88, 5 complaints) and plumbing (86, 1) are within the tie
    // margin, so the larger count wins — "plumbing stands out with 1 complaint"
    // while heat had 5 is not what standing out means.
    const text = templateExplanation({ label: "Building Health", ...BUILDING });
    expect(text.toLowerCase()).toContain("heat and hot water");
    expect(text).not.toContain("heatHotWater");
  });

  it("does not congratulate a zero-complaint result", () => {
    // An all-zero building is also what a coordinate that missed its building
    // looks like. The response already carries confidence: "low"; the text must
    // not undercut that by calling it good news.
    const text = templateExplanation({
      label: "Building Health",
      band: "good",
      counts: { heatHotWater: 0, unsanitaryCondition: 0, plumbing: 0 },
    });
    expect(text).toMatch(/no 311 complaints were filed/i);
    expect(text).not.toMatch(/excellent|great|perfect|well maintained/i);
  });

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

  it("uses singular/plural correctly", () => {
    const one = templateExplanation({
      label: "Building Health",
      band: "good",
      counts: { heatHotWater: 1, unsanitaryCondition: 0, plumbing: 0 },
    });
    // Word boundary matters: the opener contains "311 complaints", which a
    // naive /1 complaints/ would match.
    expect(one).toMatch(/\b1 complaint\b/);
    expect(one).not.toMatch(/\b1 complaints\b/);
  });
});

describe("dominantBucket", () => {
  it("prefers the worst SCORE over the largest raw count", () => {
    // Raw counts are not comparable across buckets: 144 street-condition
    // complaints can matter more than 2876 noise ones, because the citywide
    // norms differ by an order of magnitude.
    const bucket = dominantBucket({
      counts: { noise: 2876, parking: 1253, streetCondition: 144 },
      bucketScores: { noise: 80, parking: 90, streetCondition: 5 },
    });
    expect(bucket).toBe("streetCondition");
  });

  it("falls back to the largest count when scores are absent", () => {
    expect(dominantBucket({ counts: { noise: 10, parking: 99 } })).toBe("parking");
  });

  it("returns null for empty counts", () => {
    expect(dominantBucket({ counts: {} })).toBeNull();
  });
});

describe("explainFromTemplate", () => {
  it("labels its source honestly and never calls the AI", () => {
    const result = explainFromTemplate("block", BLOCK);
    expect(result.explanationSource).toBe(EXPLANATION_SOURCES.template);
    expect(result.explanation).toBeTypeOf("string");
    expect(generateSpy).not.toHaveBeenCalled();
  });
});

describe("tier labelling", () => {
  it("describes each tier's real radius", () => {
    expect(radiusLabelFor("building")).toContain("80 ft");
    expect(radiusLabelFor("block")).toContain("0.2 mi");
    expect(radiusLabelFor("nonsense")).toBeTypeOf("string");
  });

  it("covers every tier the API scores", () => {
    for (const tier of Object.keys(BUCKET_NAMES)) {
      const input = explanationInputFor(tier, { band: "fair", counts: {} });
      expect(input.label).not.toBe(tier); // a human name, not the key
    }
  });
});
