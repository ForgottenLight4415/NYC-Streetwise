/**
 * Runs every available AI adapter against the SAME fixed whole-report inputs
 * and prints the outputs side by side, next to the deterministic template.
 *
 *   npm run verify:explanations
 *
 * This is the tone-consistency check CLAUDE.md requires before demo day.
 * Llama 3 and Gemini Flash-Lite are different models and may not produce
 * similarly-toned output from an identical prompt. If they diverge noticeably,
 * tighten prompt.js — do NOT ship two different-feeling products depending on
 * which environment someone is looking at.
 *
 * Scoped to the WHOLE-REPORT summary only — the AI adapter is never called
 * for an individual section (building/block/transit/parks/bike/walkability
 * each get a deterministic "Why this score?" instead, see explain.js), so
 * "overall" is the only prompt shape left worth comparing across providers.
 *
 * Also worth reading the output for the things unit tests cannot check:
 *   - invented specifics (an address, a date, a landlord) — the worst failure
 *   - technical vocabulary leaking through ("percentile", "baseline")
 *   - derived arithmetic ("three times as many"), which models get wrong
 *   - length: under 120 words, and selective rather than a section-by-section list
 *
 * Adapters with no credentials are skipped, not failed — this must be runnable
 * locally with only Ollama, and on a machine with only a Gemini key.
 */

import { AI_PROVIDERS, AI_MODELS } from "../src/config/constants.js";
import { buildOverallSummaryPrompt } from "../src/providers/ai/prompt.js";
import { templateOverallSummary } from "../src/services/templateOverallSummary.js";

// Real report shapes, taken from live lookups. Fixed on purpose: the point is
// to compare providers against each other, which needs the inputs held
// constant.
const FIXTURES = [
  {
    name: "Bushwick — clean building, loud block",
    sections: [
      {
        label: "Building Health",
        band: "good",
        counts: { heatHotWater: 5, unsanitaryCondition: 0, plumbing: 1 },
      },
      {
        label: "Block Quality",
        band: "poor",
        counts: { noise: 2876, parking: 1253, streetCondition: 144 },
      },
    ],
  },
  {
    name: "Midtown — middling complaints, excellent transit",
    sections: [
      {
        label: "Building Health",
        band: "fair",
        counts: { heatHotWater: 12, unsanitaryCondition: 2, plumbing: 4 },
      },
      {
        label: "Block Quality",
        band: "fair",
        counts: { noise: 834, parking: 1116, streetCondition: 302 },
      },
      {
        label: "Transit Access",
        band: "excellent",
        metrics: { subway: { meters: 90, within: 4, name: "5 Av-53 St" } },
      },
    ],
  },
  {
    name: "Neglected building, car-dependent block",
    sections: [
      {
        label: "Building Health",
        band: "poor",
        counts: { heatHotWater: 412, unsanitaryCondition: 88, plumbing: 51 },
      },
      {
        label: "Block Quality",
        band: "good",
        counts: { noise: 40, parking: 12, streetCondition: 3 },
      },
      {
        label: "Transit Access",
        band: "carDependent",
        metrics: { subway: { meters: null, within: 0, name: null } },
      },
    ],
  },
];

/** Words that should never reach a renter. */
const BANNED_TERMS = ["percentile", "baseline", "median", "dataset", "score of"];
/** Phrasings that indicate the model did arithmetic it was told not to do. */
const RATIO_PATTERN = /\b(times (as )?(many|more|higher)|\d+\s?%|percent|ratio|average of)\b/i;

async function availableAdapters() {
  const available = [];

  // Ollama: available if something answers on the port.
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const models = (await res.json()).models?.map((m) => m.name) ?? [];
      if (!models.includes(AI_MODELS.ollama)) {
        console.warn(
          `WARNING: ollama is running but "${AI_MODELS.ollama}" is not pulled.\n` +
            `         Available: ${models.join(", ") || "(none)"}\n` +
            `         Run: ollama pull ${AI_MODELS.ollama}\n`
        );
      } else {
        available.push(AI_PROVIDERS.ollama);
      }
    }
  } catch {
    console.warn("SKIP ollama — nothing answering on localhost:11434 (run `ollama serve`)\n");
  }

  if (process.env.GEMINI_API_KEY) {
    available.push(AI_PROVIDERS.gemini);
  } else {
    console.warn("SKIP gemini — GEMINI_API_KEY is not set\n");
  }

  return available;
}

const providers = await availableAdapters();

if (providers.length === 0) {
  console.error(
    "No AI adapter is available, so there is nothing to compare.\n" +
      "The API still works — every summary falls back to the template."
  );
  process.exit(2);
}

console.log(`Comparing: ${providers.join(", ")}`);
for (const provider of providers) {
  console.log(`  ${provider.padEnd(8)} model ${AI_MODELS[provider]}`);
}
if (providers.length === 1) {
  console.log(
    "\nNOTE: only one adapter available, so this run cannot compare TONE across\n" +
      "providers. Re-run with both before demo day."
  );
}

let warnings = 0;

/** Every count in every section, for the "numbers not in the input" smell test. */
function allCounts(sections) {
  return sections.flatMap((s) => Object.values(s.counts ?? {})).map(String);
}

for (const fixture of FIXTURES) {
  const input = { sections: fixture.sections };
  const sectionLabels = fixture.sections.map((s) => `${s.label}/${s.band}`).join(", ");

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${fixture.name}  [${sectionLabels}]`);
  console.log("=".repeat(78));

  console.log("\n  template:");
  console.log(`    ${templateOverallSummary(fixture.sections)}`);

  for (const provider of providers) {
    process.env.AI_PROVIDER = provider;
    // Imported fresh per provider so the factory re-reads AI_PROVIDER.
    const { generateExplanation } = await import("../src/providers/ai/index.js");

    const started = performance.now();
    let text;
    try {
      text = await generateExplanation(input);
    } catch (err) {
      console.log(`\n  ${provider}:`);
      console.log(`    FAILED: ${err.message.slice(0, 160)}`);
      console.log("    (the API would serve the template above — no user-visible error)");
      warnings++;
      continue;
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);

    console.log(`\n  ${provider} (${seconds}s):`);
    console.log(`    ${text}`);

    // Automated checks for the failures that are easy to miss by eye.
    const lower = text.toLowerCase();
    for (const term of BANNED_TERMS) {
      if (lower.includes(term)) {
        console.log(`    WARN  leaked technical term: "${term}"`);
        warnings++;
      }
    }
    if (RATIO_PATTERN.test(text)) {
      console.log("    WARN  looks like derived arithmetic — models get these wrong");
      warnings++;
    }
    const ours = allCounts(fixture.sections);
    if (ours.some((n) => n !== "0")) {
      // Not exhaustive, just a smell test: numbers in the text that are not
      // ours are either arithmetic or invention.
      const numbers = text.match(/\b\d{2,}\b/g) ?? [];
      const foreign = numbers.filter((n) => !ours.includes(n) && n !== "311" && n !== "24" && n !== "120");
      if (foreign.length > 0) {
        console.log(`    WARN  numbers not in the input: ${[...new Set(foreign)].join(", ")}`);
        warnings++;
      }
    }
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount > 120) {
      console.log(`    WARN  ${wordCount} words — asked for under 120`);
      warnings++;
    }
  }
}

console.log(`\n${"=".repeat(78)}`);
console.log("Prompt sent (identical for every provider — that is the point):");
console.log("=".repeat(78));
console.log(buildOverallSummaryPrompt({ sections: FIXTURES[0].sections }));

console.log(
  warnings === 0
    ? "\nNo automated warnings. Still read the outputs above for tone and invented specifics."
    : `\n${warnings} warning(s) above. Tighten prompt.js rather than patching one adapter.`
);
