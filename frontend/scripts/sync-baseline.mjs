/**
 * Regenerates frontend/lib/citywide-baseline.ts from
 * backend/src/config/baseline.json.
 *
 *   node scripts/sync-baseline.mjs           # rewrite the file
 *   node scripts/sync-baseline.mjs --check   # exit 1 if it is out of date
 *
 * WHY THIS EXISTS. The frontend needs the citywide baseline in two places that
 * cannot fetch: CitywideBaselinePanel is a static server component rendered on a
 * cold cache (the whole point is that it works when the backend has nothing),
 * and compareToBaseline() is a pure function called synchronously from client
 * components. So the numbers have to be committed.
 *
 * They used to be committed by hand, with a comment asking the next person to
 * re-copy them. That did not survive the first rebuild: every one of the six
 * buckets had drifted, understating the citywide p90 by up to 28% (noise: 3289
 * against the real 4599), which made every address read worse than the
 * backend's own score for it said. Generating the file removes the step that
 * was being forgotten, rather than asking harder.
 *
 * --check is the guard: run it in CI, or after `yarn baseline`, and a stale
 * copy fails loudly instead of silently mis-describing the city.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_JSON = path.resolve(HERE, "../../backend/src/config/baseline.json");
const OUTPUT = path.resolve(HERE, "../lib/citywide-baseline.ts");

/**
 * The only things in the generated file that are NOT in baseline.json: how each
 * tier is labelled and coloured in the UI. Everything else — medians, p90s,
 * radii, sample size, window — is read from the backend's committed output, so
 * it cannot disagree with what the scores are computed against.
 *
 * Bucket ORDER is taken from this list too, not from Object.keys(perBucket), so
 * the rendered table's row order is a deliberate choice here rather than an
 * accident of JSON key order.
 */
const TIER_PRESENTATION = [
  {
    tier: "building",
    label: "Building Health",
    colorVar: "--series-building",
    buckets: ["heatHotWater", "unsanitaryCondition", "plumbing", "repairs", "electricGas", "buildingSafety"],
  },
  {
    tier: "block",
    label: "Block Quality",
    colorVar: "--series-block",
    buckets: ["noise", "parking", "streetCondition", "sanitation", "infrastructure", "publicSafety"],
  },
];

function render(baseline) {
  const { perBucket, radiusMeters, windowMonths, sampleSize, _id } = baseline;

  // A bucket the baseline has but TIER_PRESENTATION does not list would simply
  // never be shown, so a newly added bucket must be placed here explicitly.
  const presented = new Set(TIER_PRESENTATION.flatMap(({ buckets }) => buckets));
  const unlisted = Object.keys(perBucket ?? {}).filter((bucket) => !presented.has(bucket));
  if (unlisted.length > 0) {
    throw new Error(`baseline.json buckets missing from TIER_PRESENTATION: ${unlisted.join(", ")}`);
  }

  // A missing bucket would render a row with `undefined` medians and quietly
  // produce NaN multipliers downstream, so fail here instead.
  for (const { tier, buckets } of TIER_PRESENTATION) {
    if (!Number.isFinite(radiusMeters?.[tier])) {
      throw new Error(`baseline.json has no radiusMeters.${tier}`);
    }
    for (const bucket of buckets) {
      const stats = perBucket?.[bucket];
      if (!Number.isFinite(stats?.median) || !Number.isFinite(stats?.p90)) {
        throw new Error(`baseline.json has no usable median/p90 for "${bucket}"`);
      }
    }
  }

  const tiers = TIER_PRESENTATION.map(({ tier, label, colorVar, buckets }) => {
    const rows = buckets
      .map((key) => {
        const { median, p90 } = perBucket[key];
        return `        { key: "${key}", median: ${median}, p90: ${p90} },`;
      })
      .join("\n");

    return `    {
      label: "${label}",
      radiusMeters: ${radiusMeters[tier]},
      colorVar: "${colorVar}",
      buckets: [
${rows}
      ],
    },`;
  }).join("\n");

  return `/**
 * The citywide 311 baseline every score is measured against.
 *
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Source: backend/src/config/baseline.json (the committed output of
 * \`yarn baseline\`). Regenerate with \`yarn sync:baseline\` from
 * frontend/, which \`yarn baseline\` also does for you; \`yarn
 * verify:baseline\` fails if this file has fallen behind.
 *
 * Committed rather than fetched deliberately: CitywideBaselinePanel is what the
 * homepage shows when the score cache is cold, so it cannot itself depend on
 * the backend being reachable, and compareToBaseline() is a synchronous pure
 * function called from client components. It is real measured data either way -
 * the point of showing it is that a page with nothing cached still has
 * something true to say.
 */

export interface BaselineBucket {
  /** Bucket key, matching CATEGORY_LABEL in lib/score.ts. */
  key: string;
  median: number;
  p90: number;
}

export interface BaselineTier {
  label: string;
  radiusMeters: number;
  colorVar: string;
  buckets: BaselineBucket[];
}

export const CITYWIDE_BASELINE: {
  windowMonths: number;
  sampleSize: number;
  version: string;
  tiers: BaselineTier[];
} = {
  windowMonths: ${windowMonths},
  sampleSize: ${sampleSize},
  version: ${JSON.stringify(_id ?? "v1")},
  tiers: [
${tiers}
  ],
};
`;
}

const check = process.argv.includes("--check");

// `yarn baseline` in the backend runs this as its `postbaseline` hook, so a
// rebuild can never leave the frontend behind. (A hook, not an `&&` chain:
// yarn appends `--flags` to the END of a script, so a chain handed them to
// this file instead of buildBaseline.js.) It must not break the baseline
// build in a checkout where the other half isn't present — backend/Dockerfile
// copies only src and scripts, so ../frontend genuinely does not exist there.
// Absent either side, say so and succeed.
const [baselineRaw, current] = await Promise.all([
  readFile(BASELINE_JSON, "utf8").catch(() => null),
  readFile(OUTPUT, "utf8").catch(() => null),
]);

if (baselineRaw === null || current === null) {
  console.log(
    `Skipping baseline sync: ${baselineRaw === null ? BASELINE_JSON : OUTPUT} not found ` +
      `(single-app checkout or container build).`
  );
  process.exit(0);
}

const baseline = JSON.parse(baselineRaw);
const next = render(baseline);

if (current === next) {
  console.log(`citywide-baseline.ts is up to date with ${path.basename(BASELINE_JSON)}.`);
  process.exit(0);
}

if (check) {
  console.error(
    `citywide-baseline.ts is OUT OF DATE with backend/src/config/baseline.json.\n` +
      `The frontend is describing a different city than the scores are computed against.\n` +
      `Run: cd frontend && yarn sync:baseline`
  );
  process.exit(1);
}

await writeFile(OUTPUT, next);
console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)} from ${path.basename(BASELINE_JSON)}.`);
