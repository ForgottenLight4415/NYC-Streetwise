import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildOverallSummaryPrompt, bucketLabel } from "../src/providers/ai/prompt.js";
import { cleanExplanation, AIError } from "../src/providers/ai/shared.js";
import { generateExplanation as ollama } from "../src/providers/ai/ollama.js";
import { generateExplanation as gemini } from "../src/providers/ai/gemini.js";
import { getAdapter, activeProvider } from "../src/providers/ai/index.js";
import {
  AI_MODELS,
  AI_TEMPERATURE,
  AI_MAX_OUTPUT_TOKENS,
  EXPLANATION_MAX_CHARS,
} from "../src/config/constants.js";

// No network. `fetch` is stubbed so we can assert on what we send each provider
// and on how each behaves when the provider misbehaves — which, for this
// feature, is the case that actually matters.

// The adapters (ollama.js/gemini.js) only ever build ONE prompt shape now —
// the whole-report summary. building/block/transit/parks/bike/walkability
// each get a deterministic template instead (see explain.js), so there is no
// per-tier prompt left to test here; that content lives in the
// "buildOverallSummaryPrompt" describe block below. This INPUT is only used
// by the adapter/wire-mechanics tests further down, which don't care about
// prompt content — just that whatever buildOverallSummaryPrompt produces gets
// sent through correctly.
const INPUT = {
  sections: [
    { label: "Block Quality", band: "poor", counts: { noise: 2876, parking: 1253, streetCondition: 144 } },
  ],
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let fetchSpy;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AI_PROVIDER;
  delete process.env.GEMINI_API_KEY;
});

describe("bucketLabel", () => {
  it("humanizes bucket names", () => {
    expect(bucketLabel("heatHotWater")).toBe("heat and hot water");
    expect(bucketLabel("unknownBucket")).toBe("unknownBucket");
  });
});

describe("buildOverallSummaryPrompt", () => {
  const SECTIONS_INPUT = {
    sections: [
      { label: "Building Health", band: "good", counts: { heatHotWater: 1, unsanitaryCondition: 0, plumbing: 0 } },
      { label: "Block Quality", band: "poor", counts: { noise: 2876, parking: 1253, streetCondition: 144 } },
      {
        label: "Transit Access",
        band: "excellent",
        metrics: { subway: { meters: 240, within: 2, name: "14 St-Union Sq" } },
      },
    ],
  };

  const prompt = buildOverallSummaryPrompt(SECTIONS_INPUT);

  it("formats each section by whichever shape it carries, counts or metrics", () => {
    expect(prompt).toContain("Building Health: 1 heat and hot water");
    expect(prompt).toContain("Block Quality: 2876 noise");
    expect(prompt).toContain("Transit Access: subway station 240m away (14 St-Union Sq)");
  });

  it("asks for one summary under 120 words, not a per-section rating", () => {
    expect(prompt).toMatch(/under 120 words/i);
    expect(prompt).toMatch(/do not describe every one of them|only what stands out/i);
  });

  it("still forbids inventing specifics and derived arithmetic", () => {
    expect(prompt).toMatch(/do not invent addresses/i);
    expect(prompt).toMatch(/do not calculate ratios/i);
  });

  it("bans restating the good/fair/poor rating words, unlike the single-tier prompts", () => {
    // The single-tier prompts only forbid THEIR OWN band word; this one covers
    // all three, since it has no single badge of its own to avoid restating.
    expect(prompt).toMatch(/do not use the words good, fair, poor/i);
  });

  it("also bans the amenity-tier rating words, a separate vocabulary from good/fair/poor", () => {
    expect(prompt).toMatch(/excellent, typical, car-dependent/i);
  });

  it("requires the word 'complaints' whenever a count is mentioned, so a zero count cannot read as a fact about the building itself", () => {
    // Observed failure this guards: a zero heat/hot-water count summarized as
    // "There is no heat or hot water in the building" — a claim the building
    // HAS no heat, the opposite of what a zero-COMPLAINT record means.
    expect(prompt).toMatch(/complaints filed, not a fact about the building or block/i);
    expect(prompt).toMatch(/no heat or hot water complaints.*never.*no heat or hot water/i);
  });
});

describe("cleanExplanation", () => {
  it("passes clean text through untouched", () => {
    expect(cleanExplanation("Noise is the main issue here.", "test")).toBe(
      "Noise is the main issue here."
    );
  });

  it("strips a label the model added despite being told not to", () => {
    expect(cleanExplanation("Explanation: Noise is high.", "test")).toBe(
      "Noise is high."
    );
  });

  it("strips wrapping quotes", () => {
    expect(cleanExplanation('"Noise is high."', "test")).toBe("Noise is high.");
  });

  it("collapses newlines — this renders as one paragraph", () => {
    expect(cleanExplanation("Line one.\n\nLine two.", "test")).toBe(
      "Line one. Line two."
    );
  });

  it("truncates at a sentence boundary rather than mid-word", () => {
    const long = `${"Noise is a problem here. ".repeat(40)}`;
    const cleaned = cleanExplanation(long, "test");
    expect(cleaned.length).toBeLessThanOrEqual(EXPLANATION_MAX_CHARS);
    expect(cleaned.endsWith(".")).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   \n  "],
    ["null", null],
    ["a number", 42],
  ])("throws on %s so the caller falls back to the template", (_label, value) => {
    expect(() => cleanExplanation(value, "test")).toThrow(AIError);
  });
});

describe("ollama adapter", () => {
  it("sends the shared prompt, the configured model, and stream:false", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ response: "Noise is high here." }));
    const text = await ollama(INPUT);

    expect(text).toBe("Noise is high here.");
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain("11434");
    const body = JSON.parse(options.body);
    expect(body.model).toBe(AI_MODELS.ollama);
    // Without stream:false Ollama returns NDJSON and res.json() chokes.
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(AI_TEMPERATURE);
    expect(body.prompt).toBe(buildOverallSummaryPrompt(INPUT));
  });

  it("reports an unreachable server clearly — the normal local failure", async () => {
    fetchSpy.mockRejectedValue(new Error("fetch failed"));
    await expect(ollama(INPUT)).rejects.toThrow(/ollama unreachable/);
  });

  it("throws AIError on a non-200", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "no model" }, 404));
    await expect(ollama(INPUT)).rejects.toThrow(AIError);
  });

  it("throws AIError when the model returns nothing", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ response: "" }));
    await expect(ollama(INPUT)).rejects.toThrow(AIError);
  });
});

describe("gemini adapter", () => {
  const okPayload = {
    candidates: [{ content: { parts: [{ text: "Noise is high here." }] } }],
  };

  it("refuses to call without an API key", async () => {
    await expect(gemini(INPUT)).rejects.toThrow(/GEMINI_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the key as a header, not a query string", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    fetchSpy.mockResolvedValue(jsonResponse(okPayload));
    await gemini(INPUT);

    const [url, options] = fetchSpy.mock.calls[0];
    // A key in the URL ends up in access logs.
    expect(url).not.toContain("test-key");
    expect(options.headers["x-goog-api-key"]).toBe("test-key");
    expect(url).toContain(AI_MODELS.gemini);
  });

  it("sends the shared prompt and the configured generation settings", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    fetchSpy.mockResolvedValue(jsonResponse(okPayload));
    await gemini(INPUT);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.generationConfig.temperature).toBe(AI_TEMPERATURE);
    expect(body.generationConfig.maxOutputTokens).toBe(AI_MAX_OUTPUT_TOKENS);
    expect(body.contents[0].parts[0].text).toBe(buildOverallSummaryPrompt(INPUT));
  });

  it("omits thinkingConfig unless a budget is configured", async () => {
    // gemini-3.5-flash-lite (the default) rejects the field with a 400.
    process.env.GEMINI_API_KEY = "test-key";
    fetchSpy.mockResolvedValue(jsonResponse(okPayload));
    await gemini(INPUT);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("explains a MAX_TOKENS-with-no-text response as a thinking-budget problem", async () => {
    // Measured on gemini-2.5-flash: 111 thinking tokens ate the 120-token cap
    // and the response came back as the fragment "Living here, you would".
    // "MAX_TOKENS" alone is not an actionable error message.
    process.env.GEMINI_API_KEY = "test-key";
    fetchSpy.mockResolvedValue(
      jsonResponse({
        candidates: [{ finishReason: "MAX_TOKENS", content: {} }],
        usageMetadata: { thoughtsTokenCount: 111 },
      })
    );
    await expect(gemini(INPUT)).rejects.toThrow(/GEMINI_THINKING_BUDGET=0/);
  });

  it("surfaces a rate limit as an AIError with its status", async () => {
    // The failure most likely to happen mid-demo on the free tier.
    process.env.GEMINI_API_KEY = "test-key";
    fetchSpy.mockResolvedValue(jsonResponse({ error: "quota" }, 429));
    await expect(gemini(INPUT)).rejects.toMatchObject({
      name: "AIError",
      status: 429,
    });
  });

  it("explains an empty response using the block reason", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    fetchSpy.mockResolvedValue(
      jsonResponse({ candidates: [{ finishReason: "SAFETY", content: {} }] })
    );
    await expect(gemini(INPUT)).rejects.toThrow(/SAFETY/);
  });

  it("joins multi-part responses", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    fetchSpy.mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "Noise " }, { text: "is high." }] } }],
      })
    );
    expect(await gemini(INPUT)).toBe("Noise is high.");
  });
});

describe("adapter factory", () => {
  it("defaults to ollama for local dev", () => {
    expect(activeProvider()).toBe("ollama");
  });

  it("selects the adapter from AI_PROVIDER, case-insensitively", () => {
    process.env.AI_PROVIDER = "GEMINI";
    expect(getAdapter()).toBe(gemini);
    process.env.AI_PROVIDER = "ollama";
    expect(getAdapter()).toBe(ollama);
  });

  it("throws on an unknown provider rather than silently defaulting", () => {
    // A typo in a Vercel env var would otherwise mean every explanation is a
    // template and nobody notices the AI feature is dead.
    process.env.AI_PROVIDER = "openai";
    expect(() => getAdapter()).toThrow(/unknown AI_PROVIDER/);
  });

  it("reads the env var at call time, not import time", () => {
    process.env.AI_PROVIDER = "gemini";
    expect(getAdapter()).toBe(gemini);
    process.env.AI_PROVIDER = "ollama";
    expect(getAdapter()).toBe(ollama);
  });
});

describe("gemini thinking-config compatibility", () => {
  // Whether thinkingConfig is accepted is model-dependent and there is no safe
  // universal value: gemini-3.5-flash-lite 400s on it, gemini-2.5-flash needs
  // it. A model swap must degrade, not break.
  const okPayload = {
    candidates: [{ content: { parts: [{ text: "Noise is high here." }] } }],
  };

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_THINKING_BUDGET = "0";
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.GEMINI_THINKING_BUDGET;
    vi.resetModules();
  });

  it("sends the budget when one is configured", async () => {
    const { generateExplanation } = await import("../src/providers/ai/gemini.js");
    fetchSpy.mockResolvedValue(jsonResponse(okPayload));
    await generateExplanation(INPUT);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("retries without thinkingConfig when the model rejects it with a 400", async () => {
    const { generateExplanation } = await import("../src/providers/ai/gemini.js");
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ error: "invalid argument" }, 400))
      .mockResolvedValueOnce(jsonResponse(okPayload));

    expect(await generateExplanation(INPUT)).toBe("Noise is high here.");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(fetchSpy.mock.calls[1][1].body).generationConfig.thinkingConfig
    ).toBeUndefined();
  });

  it("still fails cleanly when the retry also 400s", async () => {
    const { generateExplanation } = await import("../src/providers/ai/gemini.js");
    fetchSpy.mockResolvedValue(jsonResponse({ error: "bad request" }, 400));
    await expect(generateExplanation(INPUT)).rejects.toMatchObject({ status: 400 });
  });
});
