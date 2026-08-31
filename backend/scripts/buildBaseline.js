/**
 * Computes the citywide baseline the scorer compares every address against.
 *
 *   npm run baseline               # default sample size
 *   npm run baseline -- --samples=80 --dry-run
 *
 * WHY THIS EXISTS: without it we would be showing raw complaint counts, and "47
 * noise complaints" is meaningless to a renter. The baseline turns a count into
 * "quieter than 78% of NYC", which is a defensible score. CLAUDE.md: do not skip.
 *
 * WHAT IT DOES
 *   1. Draws sample coordinates from REAL 311 records, spread across the five
 *      boroughs and thinned so no single dense block dominates.
 *   2. Calls getCounts() on each (cache-first, so a rerun is nearly free).
 *   3. Takes median + p90 per bucket per tier.
 *   4. Writes src/config/baseline.json (COMMIT IT) and, if Mongo is configured,
 *      the `baseline` document.
 *
 * EACH TIER IS SAMPLED SEPARATELY, and that matters more than it looks.
 *
 * Sampling coordinates must come from 311 records, NOT points picked off a map:
 * M2 established that a mid-street coordinate returns ZERO building complaints,
 * so a map-sampled baseline would put the building median at 0 and score every
 * real building as poor.
 *
 * But drawing BUILDING-tier points from all complaint types has the same
 * problem in miniature. Illegal Parking and Street Condition geocode to street
 * locations, not buildings; the first version of this script sampled both tiers
 * from one pooled draw and 36.5% of the resulting points had zero complaints in
 * every building bucket. Those street points pushed the building median down to
 * ~1, so genuine residential buildings were scored against a distribution that
 * was mostly not buildings — systematically telling renters a building was
 * worse than its real peers.
 *
 * So: building-tier points are drawn only from HPD building-interior complaints
 * (heat, plumbing, unsanitary), which are always residential building
 * addresses. Block-tier points are drawn from every type, which is what a block
 * actually is. Cost is unchanged — one tier per point instead of two.
 *
 * RESIDUAL BIAS — read before trusting the numbers. Points are still drawn from
 * locations that generated at least one 311 complaint, so a building nobody has
 * ever complained about cannot be sampled. That biases the baseline HIGH
 * (toward complaint-generating locations), making real scores slightly generous
 * rather than harsh. Fixing it properly needs a building-footprint dataset
 * (PLUTO) and is not hackathon-scoped.
 */

import { writeFile } from "node:fs/promises";
import {
  ALL_COMPLAINT_TYPES,
  BUILDING_HEALTH_TYPES,
  BASELINE_ID,
  BASELINE_SAMPLE_CONCURRENCY,
  BASELINE_SAMPLE_SEED,
  BASELINE_SAMPLE_SIZE,
  BUCKET_NAMES,
  RADIUS_TIERS,
  WINDOW_MONTHS,
  windowCutoffISO,
} from "../src/config/constants.js";
import { getCounts } from "../src/services/scoreService.js";
import { ensureCacheIndexes } from "../src/providers/cache.js";
import { closeMongo, isMongoConfigured } from "../src/providers/mongo.js";
import { saveBaseline, BASELINE_FILE_PATH } from "../src/providers/baseline.js";
import { seededRandom, boroughQuotas, sampleCoordinates } from "./lib/sampleCoords.js";

// --- args --------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);

const SAMPLE_SIZE = Number(args.samples) || BASELINE_SAMPLE_SIZE;
const DRY_RUN = args["dry-run"] === "true";
// Oversample before thinning: dense boroughs lose a lot of points to the grid.
const OVERSAMPLE = 6;
const CHUNKS_PER_BOROUGH = 5;
const CHUNK_WINDOW_DAYS = 21;
const SAMPLING_TIMEOUT_MS = 30000;

// --- deterministic RNG -------------------------------------------------------
//
// ONE seeded RNG instance for this script's whole run, threaded through every
// sampleCoordinates() call in scripts/lib/sampleCoords.js in the same order
// as before this was extracted (building's chunks, then block's) — this is
// what keeps a rerun byte-for-byte reproducible. See that module's header.

const rand = seededRandom(BASELINE_SAMPLE_SEED);

const CUTOFF = windowCutoffISO();

/**
 * Where each tier's sample coordinates come from. See the header: building
 * points must be actual buildings, so they are drawn from HPD's
 * building-interior complaints only. Block points are drawn from everything.
 */
const SAMPLE_SOURCES = {
  building: {
    label: "HPD building-interior complaints",
    types: Object.values(BUILDING_HEALTH_TYPES).flat(),
  },
  block: {
    label: "all complaint types",
    types: ALL_COMPLAINT_TYPES,
  },
};

async function buildSample(quotas, tier) {
  const { label, types } = SAMPLE_SOURCES[tier];
  return sampleCoordinates({
    quotas,
    types,
    label: `${tier}-tier coordinates from ${label}`,
    cutoffISO: CUTOFF,
    rand,
    chunksPerBorough: CHUNKS_PER_BOROUGH,
    chunkWindowDays: CHUNK_WINDOW_DAYS,
    oversample: OVERSAMPLE,
    timeoutMs: SAMPLING_TIMEOUT_MS,
  });
}

// --- step 3: counts ----------------------------------------------------------

/** Bounded-concurrency map. Two HTTP calls per point — do not flood Socrata. */
async function mapWithConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        results[current] = await worker(items[current], current);
      }
    })
  );
  return results;
}

async function collectCounts(sample, tier) {
  console.log(
    `\n=== Counting ${tier} complaints at ${sample.length} points ` +
      `(${BASELINE_SAMPLE_CONCURRENCY} at a time, cache-first) ===`
  );

  let done = 0;
  let failed = 0;
  const started = performance.now();

  const results = await mapWithConcurrency(
    sample,
    BASELINE_SAMPLE_CONCURRENCY,
    async (point) => {
      try {
        // One tier per point, not both: each tier has its own sample, so
        // fetching the other one here would be a wasted HTTP call.
        const { counts } = await getCounts(point.lat, point.lng, { tiers: [tier] });
        return counts[tier];
      } catch (err) {
        failed++;
        if (failed <= 3) console.warn(`  warn: ${err.message.slice(0, 120)}`);
        return null;
      } finally {
        done++;
        if (done % 25 === 0 || done === sample.length) {
          const elapsed = (performance.now() - started) / 1000;
          console.log(
            `  ${String(done).padStart(4)}/${sample.length}` +
              `  ${elapsed.toFixed(0)}s elapsed, ${failed} failed`
          );
        }
      }
    }
  );

  const usable = results.filter(Boolean);

  // A baseline built from a handful of surviving points is worse than no
  // baseline: it would look authoritative and be noise. Refuse instead.
  if (usable.length < sample.length * 0.7) {
    throw new Error(
      `only ${usable.length}/${sample.length} points returned counts — ` +
        `Socrata is probably degraded. Not writing a baseline from this.`
    );
  }
  return usable;
}

// --- step 4: percentiles -----------------------------------------------------

/**
 * Nearest-rank percentile on the sorted sample: p(k) is the smallest value at
 * or above which k% of the sample sits. No interpolation — with heavily
 * zero-inflated buckets, interpolating between ranks invents values the data
 * never contained.
 */
function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedValues.length);
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, rank - 1))];
}

function summarize(countsByTier) {
  const perBucket = {};
  const perTierSamples = {};

  for (const [tier, buckets] of Object.entries(BUCKET_NAMES)) {
    const countsList = countsByTier[tier];
    perTierSamples[tier] = countsList.length;
    for (const bucket of buckets) {
      const values = countsList
        .map((counts) => counts?.[bucket])
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

      perBucket[bucket] = {
        median: percentile(values, 0.5),
        p90: percentile(values, 0.9),
        // zeroShare is READ BY THE SCORER (these buckets are heavily
        // zero-inflated — half of NYC has no plumbing complaints, so the curve
        // needs to know how wide the zero tie is). mean/max/n are diagnostics
        // that tell you at a glance whether a bucket's baseline is degenerate.
        mean: values.length
          ? Number((values.reduce((sum, n) => sum + n, 0) / values.length).toFixed(2))
          : 0,
        max: values.length ? values[values.length - 1] : 0,
        zeroShare: values.length
          ? Number((values.filter((n) => n === 0).length / values.length).toFixed(3))
          : 1,
        n: values.length,
      };
    }
  }
  return { perBucket, perTierSamples };
}

// --- run ---------------------------------------------------------------------

if (!process.env.SOCRATA_APP_TOKEN) {
  console.warn("WARNING: SOCRATA_APP_TOKEN unset — expect throttling\n");
}

if (isMongoConfigured()) {
  // Not awaited-critical, but the sample is about to issue hundreds of cache
  // reads; having the index in place first keeps them from being collection scans.
  await ensureCacheIndexes().catch((err) =>
    console.warn("[baseline] index setup failed, continuing:", err.message)
  );
} else {
  console.warn(
    "NOTE: MONGODB_URI unset — no cache, so every point costs a live call " +
      "and a rerun will not be free.\n"
  );
}

const quotas = await boroughQuotas({
  size: SAMPLE_SIZE,
  cutoffISO: CUTOFF,
  timeoutMs: SAMPLING_TIMEOUT_MS,
});

const countsByTier = {};
for (const tier of Object.keys(RADIUS_TIERS)) {
  const sample = await buildSample(quotas, tier);
  countsByTier[tier] = await collectCounts(sample, tier);
}

const { perBucket, perTierSamples } = summarize(countsByTier);

const doc = {
  _id: BASELINE_ID,
  perBucket,
  // A baseline is only valid for the radii it was sampled at. Recorded so the
  // scorer can detect a retuned radius instead of silently shifting every score.
  radiusMeters: Object.fromEntries(
    Object.entries(RADIUS_TIERS).map(([tier, { radiusMeters }]) => [tier, radiusMeters])
  ),
  windowMonths: WINDOW_MONTHS,
  // Each tier has its own sample drawn from its own source — see the header.
  sampleSize: Math.min(...Object.values(perTierSamples)),
  sampleRequested: SAMPLE_SIZE,
  perTierSamples,
  sampleSources: Object.fromEntries(
    Object.entries(SAMPLE_SOURCES).map(([tier, { label }]) => [tier, label])
  ),
  computedAt: new Date().toISOString(),
};

console.log("\n=== Baseline ===");
console.log(
  `  ${"bucket".padEnd(20)} ${"median".padStart(7)} ${"p90".padStart(7)}` +
    ` ${"mean".padStart(8)} ${"max".padStart(7)} ${"zero%".padStart(7)}`
);
for (const [tier, buckets] of Object.entries(BUCKET_NAMES)) {
  console.log(
    `  -- ${tier} (${RADIUS_TIERS[tier].radiusMeters}m, ` +
      `n=${perTierSamples[tier]} from ${SAMPLE_SOURCES[tier].label})`
  );
  for (const bucket of buckets) {
    const stats = perBucket[bucket];
    console.log(
      `  ${bucket.padEnd(20)} ${String(stats.median).padStart(7)}` +
        ` ${String(stats.p90).padStart(7)} ${String(stats.mean).padStart(8)}` +
        ` ${String(stats.max).padStart(7)} ${(stats.zeroShare * 100).toFixed(0).padStart(6)}%`
    );
  }
}

if (DRY_RUN) {
  console.log("\n--dry-run: nothing written.");
} else {
  await writeFile(BASELINE_FILE_PATH, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nWrote ${BASELINE_FILE_PATH} — COMMIT THIS FILE.`);

  const savedToMongo = await saveBaseline(doc);
  console.log(
    savedToMongo
      ? `Wrote baseline document _id="${BASELINE_ID}" to Mongo.`
      : "Mongo not written (unconfigured or unreachable) — the committed file is enough to serve scores."
  );
}

await closeMongo();
console.log(
  `\nDone: ${Object.entries(perTierSamples)
    .map(([tier, n]) => `${n} ${tier}`)
    .join(", ")} points, ${WINDOW_MONTHS}-month window.`
);
