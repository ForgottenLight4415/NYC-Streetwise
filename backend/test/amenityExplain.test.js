import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { amenityTemplateExplanation } from "../src/services/templateAmenityExplanation.js";
import { amenityBucketLabel } from "../src/providers/ai/prompt.js";
import { EXPLANATION_SOURCES } from "../src/config/constants.js";

const { generateSpy } = vi.hoisted(() => ({ generateSpy: vi.fn() }));

vi.mock("../src/providers/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, generateExplanation: generateSpy };
});

const { explainFromTemplate, explanationInputFor, radiusLabelFor, TIER_LABELS } =
  await import("../src/services/explain.js");

const TRANSIT_SCORE = {
  band: "good",
  metrics: {
    subway: { meters: 240, within: 2, name: "14 St-Union Sq" },
    bus: { meters: 90, within: 3, name: "Broadway/E 14 St" },
    rail: { meters: null, within: 0, name: null },
  },
  bucketScores: { subway: 92, bus: 96, rail: 0 },
};

const ALL_NULL_TRANSIT_SCORE = {
  band: "poor",
  metrics: {
    subway: { meters: null, within: 0, name: null },
    bus: { meters: null, within: 0, name: null },
    rail: { meters: null, within: 0, name: null },
  },
  bucketScores: { subway: 0, bus: 0, rail: 0 },
};

beforeEach(() => {
  generateSpy.mockReset();
  generateSpy.mockResolvedValue("A sentence about nearby transit.");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("radiusLabelFor / explanationInputFor for amenity tiers", () => {
  it("labels amenity tiers, not just building/block", () => {
    expect(TIER_LABELS.transit).toBe("Transit Access");
    expect(TIER_LABELS.parks).toBe("Parks Access");
    expect(TIER_LABELS.bike).toBe("Bike Access");
  });

  it("uses 'this location' as the subject, not 'this block' (the old ternary's fallback)", () => {
    expect(radiusLabelFor("transit")).toBe("this location (800m radius)");
  });

  it("passes metrics, not counts, for an amenity tier", () => {
    const input = explanationInputFor("transit", TRANSIT_SCORE);
    expect(input.metrics).toBe(TRANSIT_SCORE.metrics);
    expect(input).not.toHaveProperty("counts");
  });

  it("still passes counts, not metrics, for a complaint tier", () => {
    const input = explanationInputFor("building", { band: "good", counts: { heatHotWater: 1 } });
    expect(input.counts).toEqual({ heatHotWater: 1 });
    expect(input).not.toHaveProperty("metrics");
  });
});

describe("amenityTemplateExplanation", () => {
  it("names the single nearest amenity across all buckets in the tier", () => {
    const text = amenityTemplateExplanation({
      label: "Transit Access",
      band: "good",
      metrics: TRANSIT_SCORE.metrics,
    });
    // Bus (90m) is nearer than subway (240m) — the sentence should lead with it.
    expect(text).toContain("Broadway/E 14 St");
    expect(text).toContain(`${amenityBucketLabel("bus")}`);
  });

  it("says nothing was found nearby when every bucket is null, without inventing a reason", () => {
    const text = amenityTemplateExplanation({
      label: "Transit Access",
      band: "poor",
      metrics: ALL_NULL_TRANSIT_SCORE.metrics,
    });
    expect(text.length).toBeGreaterThan(10);
    expect(text.toLowerCase()).toContain("nothing");
  });

  it("never throws on malformed input", () => {
    for (const bad of [undefined, null, {}, { metrics: null }, { metrics: {} }]) {
      expect(() => amenityTemplateExplanation(bad ?? {})).not.toThrow();
    }
  });
});

describe("explainFromTemplate for an amenity tier", () => {
  it("routes to the amenity template, not the complaint one", () => {
    const result = explainFromTemplate("transit", TRANSIT_SCORE);
    expect(result.explanationSource).toBe(EXPLANATION_SOURCES.template);
    expect(result.explanation).toContain("Broadway/E 14 St");
  });
});

