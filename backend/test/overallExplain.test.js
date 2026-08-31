import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { templateOverallSummary } from "../src/services/templateOverallSummary.js";
import { EXPLANATION_SOURCES } from "../src/config/constants.js";

// The whole-report-summary analogue of explain.test.js / amenityExplain.test.js.
// This is the one AI text on the page that spans every section, so its own
// tests focus on the thing unique to it: picking ONE fact per kind rather
// than describing every section, and never short-circuiting the AI call the
// way the per-section complaint prompt does on an all-zero building.

const { generateSpy } = vi.hoisted(() => ({ generateSpy: vi.fn() }));

vi.mock("../src/providers/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, generateExplanation: generateSpy };
});

const { explainOverallWithAI, explainOverallFromTemplate, overallSections } =
  await import("../src/services/explain.js");

const REPORT = {
  buildingHealth: {
    band: "good",
    counts: { heatHotWater: 1, unsanitaryCondition: 0, plumbing: 0 },
    bucketScores: { heatHotWater: 90, unsanitaryCondition: 100, plumbing: 100 },
  },
  blockQuality: {
    band: "poor",
    counts: { noise: 2876, parking: 1253, streetCondition: 144 },
    bucketScores: { noise: 18, parking: 46, streetCondition: 44 },
  },
  transitAccess: {
    band: "good",
    metrics: {
      subway: { meters: 240, within: 2, name: "14 St-Union Sq" },
      bus: { meters: 90, within: 3, name: "Broadway/E 14 St" },
      rail: { meters: null, within: 0, name: null },
    },
  },
  // parksAccess/bikeAccess/walkabilityAccess intentionally omitted — a report
  // does not always have every amenity tier, and overallSections must not choke.
};

const ALL_ZERO_REPORT = {
  buildingHealth: {
    band: "good",
    counts: { heatHotWater: 0, unsanitaryCondition: 0, plumbing: 0 },
  },
  blockQuality: {
    band: "good",
    counts: { noise: 0, parking: 0, streetCondition: 0 },
  },
};

beforeEach(() => {
  generateSpy.mockReset();
  generateSpy.mockResolvedValue("A summary sentence about this address.");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("overallSections", () => {
  it("flattens present report sections with human labels, skipping absent ones", () => {
    const sections = overallSections(REPORT);
    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.label)).toEqual([
      "Building Health",
      "Block Quality",
      "Transit Access",
    ]);
  });

  it("passes counts for complaint tiers and metrics for amenity tiers", () => {
    const [building, , transit] = overallSections(REPORT);
    expect(building.counts).toBe(REPORT.buildingHealth.counts);
    expect(building).not.toHaveProperty("metrics");
    expect(transit.metrics).toBe(REPORT.transitAccess.metrics);
    expect(transit).not.toHaveProperty("counts");
  });

  it("never throws on a report with only the two required sections", () => {
    expect(() => overallSections(ALL_ZERO_REPORT)).not.toThrow();
    expect(overallSections(ALL_ZERO_REPORT)).toHaveLength(2);
  });
});

describe("templateOverallSummary", () => {
  it("always returns a non-empty sentence", () => {
    const text = templateOverallSummary(overallSections(REPORT));
    expect(text).toBeTypeOf("string");
    expect(text.length).toBeGreaterThan(10);
  });

  it("is deterministic — the same input gives the same text", () => {
    const sections = overallSections(REPORT);
    expect(templateOverallSummary(sections)).toBe(templateOverallSummary(sections));
  });

  it("covers BOTH complaint tiers, not just the worse-banded one", () => {
    // blockQuality is "poor" with noise standing out; buildingHealth is "good"
    // with heat/hot water standing out. Unlike the old ~100-word version
    // (which picked one complaint fact for the whole report), both must
    // appear — see templateOverallSummary.js's file header.
    const text = templateOverallSummary(overallSections(REPORT));
    expect(text.toLowerCase()).toContain("noise");
    expect(text.toLowerCase()).toContain("heat and hot water");
  });

  it("names the single nearest amenity within the transit topic", () => {
    // bus (90m) is nearer than subway (240m).
    const text = templateOverallSummary(overallSections(REPORT));
    expect(text).toContain("Broadway/E 14 St");
  });

  it("says no complaints were filed when every complaint section is all-zero", () => {
    const text = templateOverallSummary(overallSections(ALL_ZERO_REPORT));
    expect(text.toLowerCase()).toContain("no 311 complaints");
  });

  it("never throws on malformed or empty input", () => {
    for (const bad of [undefined, [], [{}], [{ counts: {} }, { metrics: {} }]]) {
      expect(() => templateOverallSummary(bad)).not.toThrow();
    }
  });

  it("stays in the neighborhood of the ~120-word AI target for a full report", () => {
    // REPORT only has 3 of the 6 possible sections (no parks/bike/walkability),
    // so a full report — every topic present — is what actually exercises the
    // ~120-word target from CLAUDE.md / buildOverallSummaryPrompt().
    const fullSections = [
      ...overallSections(REPORT),
      {
        label: "Parks Access",
        band: "typical",
        metrics: {
          park: { meters: 500, within: 1, name: "Union Square Park" },
          playground: { meters: 900, within: 0, name: null },
          garden: { meters: null, within: 0, name: null },
        },
      },
      {
        label: "Bike Access",
        band: "excellent",
        metrics: {
          bikeShare: { meters: 150, within: 2, name: "E 14 St & 3 Ave" },
          bikeLane: { meters: 50, within: 5, name: null },
          protectedLane: { meters: 300, within: 2, name: null },
        },
      },
      {
        label: "Walkability",
        band: "excellent",
        metrics: {
          grocery: { meters: 120, within: 3, name: "Trader Joe's" },
          restaurant: { meters: 40, within: 10, name: null },
          cafe: { meters: 80, within: 4, name: null },
          school: { meters: 600, within: 1, name: null },
        },
      },
    ];
    const text = templateOverallSummary(fullSections);
    const wordCount = text.split(/\s+/).length;
    // Well above the old ~50-word ceiling (single fact for the whole report),
    // comfortably below the AI path's 120-word hard cap.
    expect(wordCount).toBeGreaterThan(60);
    expect(wordCount).toBeLessThan(120);
  });

  it("covers all three amenity topics — transit, parks/bike, and walkability", () => {
    const fullSections = [
      ...overallSections(REPORT),
      {
        label: "Bike Access",
        band: "excellent",
        metrics: { bikeLane: { meters: 50, within: 5, name: null } },
      },
      {
        label: "Walkability",
        band: "excellent",
        metrics: { restaurant: { meters: 40, within: 10, name: null } },
      },
    ];
    const text = templateOverallSummary(fullSections);
    expect(text.toLowerCase()).toContain("transit");
    expect(text.toLowerCase()).toContain("bike lane");
    expect(text.toLowerCase()).toContain("restaurant");
  });
});

describe("explainOverallFromTemplate", () => {
  it("labels its source honestly and never calls the AI", () => {
    const result = explainOverallFromTemplate(REPORT);
    expect(result.explanationSource).toBe(EXPLANATION_SOURCES.template);
    expect(result.explanation).toBeTypeOf("string");
    expect(generateSpy).not.toHaveBeenCalled();
  });
});

describe("explainOverallWithAI", () => {
  it("returns AI text when the adapter succeeds", async () => {
    const result = await explainOverallWithAI(REPORT);
    expect(result.explanationSource).toBe(EXPLANATION_SOURCES.ai);
    expect(result.explanation).toBe("A summary sentence about this address.");
  });

  it("sends a `sections` array to the adapter, not counts/metrics/band directly", async () => {
    await explainOverallWithAI(REPORT);
    const input = generateSpy.mock.calls[0][0];
    expect(Object.keys(input)).toEqual(["sections"]);
    expect(Array.isArray(input.sections)).toBe(true);
    expect(input.sections).toHaveLength(3);
  });

  it("does NOT short-circuit on an all-zero report — unlike a single complaint tier", async () => {
    // A whole-report summary can still have amenity facts worth saying even
    // when every complaint count is zero, so it must not skip the AI call
    // the way explainWithAI does for one all-zero complaint tier.
    await explainOverallWithAI(ALL_ZERO_REPORT);
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a timeout", () => generateSpy.mockRejectedValue(new Error("timed out"))],
    ["a rate limit", () => generateSpy.mockRejectedValue(new Error("429 quota"))],
    ["a non-Error throw", () => generateSpy.mockImplementation(() => { throw "boom"; })],
  ])("falls back to the template on %s", async (_label, arrange) => {
    arrange();
    const result = await explainOverallWithAI(REPORT);
    expect(result.explanationSource).toBe(EXPLANATION_SOURCES.template);
    expect(result.explanation.length).toBeGreaterThan(10);
    expect(result.error).toBeDefined();
  });

  it("never rejects, whatever the adapter does", async () => {
    generateSpy.mockRejectedValue(new Error("catastrophe"));
    await expect(explainOverallWithAI(REPORT)).resolves.toBeDefined();
  });
});
