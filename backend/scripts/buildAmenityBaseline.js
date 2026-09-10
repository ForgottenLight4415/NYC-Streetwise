/**
 * Computes the citywide amenity baseline (transit/parks/bike) the amenity
 * scorer compares every address against — the amenity-scores analogue of
 * buildBaseline.js.
 *
 *   npm run baseline:amenities
 *   npm run baseline:amenities -- --samples=80 --dry-run
 *
 * WHY THIS EXISTS: same reason as buildBaseline.js — percentile-vs-citywide
 * is the whole defensibility argument, and that needs a baseline computed
 * against real sample points, not assumed.
 *
 * WHAT'S SHARED WITH buildBaseline.js, AND WHAT ISN'T. The coordinate
 * sampling — borough quotas, thinned candidate draws from real 311 records —
 * is the SAME sampler (scripts/lib/sampleCoords.js), for the SAME reason: a
 * map-picked point (the middle of a highway, a park interior) is not
 * representative of where anyone actually lives, so sample points still need
 * to come from real complaint locations. That step still costs one round of
 * Socrata calls, same as the complaint baseline's own sampling step.
 *
 * THE MEASUREMENT STEP DOES HIT THE NETWORK, deliberately. getAmenityMetrics()
 * always tries a live Google Routes correction (see CLAUDE.md's amenity
 * scores section) — and it has to here too, not just on /api/score: this
 * baseline's median/p90 anchors are the reference every LIVE, route-corrected
 * report gets percentiled against. If this script measured cheap straight-
 * line distances instead, the baseline would be built from systematically
 * smaller numbers than what a real report ever measures (walking routes
 * detour around blocks/rivers/one-ways; straight-line never does), and every
 * live score would read as worse than it should, uniformly. So this script
 * is slower and non-free unlike buildBaseline.js's per-point cost comparison
 * once suggested — see AMENITY_BASELINE_ROUTE_RETRIES/_PACING_MS below for
 * how it stays reliable anyway.
 *
 * ~150 sequential, uncached, live Routes calls with no other caller sharing
 * the quota is enough to trip Google's per-second rate limit mid-run — that
 * showed up as `[googleRoutes] computeRouteMatrix 429` warnings degrading
 * scattered points to straight-line, which would make the baseline a
 * nondeterministic mix depending on exactly when the quota was hit, breaking
 * the determinism this baseline is documented to have. Two mitigations, both
 * in getAmenityMetrics()/computeWalkingDistances(): a fixed pacing delay
 * between points (AMENITY_BASELINE_ROUTE_PACING_MS) to stay under the
 * steady-state quota, plus bounded jittered retry-with-backoff on 429/5xx
 * (AMENITY_BASELINE_ROUTE_RETRIES, same pattern as providers/socrata.js's
 * query()) to absorb the rest. The request path keeps its 0-retry fail-fast
 * default — this override is scoped to this script only.
 *
 * Sampled from ALL_COMPLAINT_TYPES (the same source as buildBaseline.js's
 * block tier), not just HPD building-interior types — amenity access is not
 * a building-interior question the way heat/plumbing are, it applies to any
 * real address a person could stand at.
 *
 * NULL DISTANCES (nothing within AMENITY_MAX_METERS) are imputed to
 * AMENITY_MAX_METERS for percentile purposes, not excluded. Excluding them
 * would silently bias the baseline toward well-served points — the same
 * shape of error buildBaseline.js's header warns about for zero-complaint
 * bias, just in the other direction. This also matches how the SCORER
 * treats a null distance (scores as the cap; see scoring.js).
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  AMENITY_BASELINE_SAMPLE_SEED,
  AMENITY_BASELINE_SAMPLE_SIZE,
  AMENITY_BASELINE_ID,
  AMENITY_BASELINE_ROUTE_RETRIES,
  AMENITY_BASELINE_ROUTE_PACING_MS,
  AMENITY_BUCKET_NAMES,
  AMENITY_MAX_METERS,
  AMENITY_TIERS,
  ALL_COMPLAINT_TYPES,
  windowCutoffISO,
} from "../src/config/constants.js";
import { seededRandom, boroughQuotas, sampleCoordinates } from "./lib/sampleCoords.js";
import { getAmenityMetrics } from "../src/services/amenityService.js";
import { closeMongo, isMongoConfigured } from "../src/providers/mongo.js";
import {
  saveAmenityBaseline,
  AMENITY_BASELINE_FILE_PATH,
} from "../src/providers/amenityBaseline.js";

// --- args --------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);

const SAMPLE_SIZE = Number(args.samples) || AMENITY_BASELINE_SAMPLE_SIZE;
const DRY_RUN = args["dry-run"] === "true";
const SAMPLING_TIMEOUT_MS = 30000;

const rand = seededRandom(AMENITY_BASELINE_SAMPLE_SEED);
const CUTOFF = windowCutoffISO();

// --- percentiles ---------------------------------------------------------

/**
 * Nearest-rank percentile on the sorted sample — same method as
 * buildBaseline.js's percentile(), duplicated rather than shared: five lines,
 * stable, and not worth a module for.
 */
function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedValues.length);
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, rank - 1))];
}

function summarize(metersByBucket) {
  const perBucket = {};
  for (const [bucket, values] of Object.entries(metersByBucket)) {
    const sorted = [...values].sort((a, b) => a - b);
    perBucket[bucket] = {
      median: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      mean: sorted.length
        ? Number((sorted.reduce((sum, n) => sum + n, 0) / sorted.length).toFixed(1))
        : 0,
      max: sorted.length ? sorted[sorted.length - 1] : 0,
      // Distances are continuous, not zero-inflated like complaint counts —
      // this will typically be ~0. Still computed (not hardcoded) so the
      // scorer's anchorsFor() sees the real, honest value either way; see
      // this script's header and CLAUDE.md for why an inert-but-present
      // zeroShare is correct here, not a bug to "fix".
      zeroShare: sorted.length
        ? Number((sorted.filter((n) => n === 0).length / sorted.length).toFixed(3))
        : 1,
      n: sorted.length,
    };
  }
  return perBucket;
}

// --- run -----------------------------------------------------------------

if (isMongoConfigured()) {
  // Amenities load lazily inside getAmenityMetrics() on first call; nothing
  // to pre-warm here the way ensureCacheIndexes() does for the 311 caches —
  // amenity_datasets and amenity_baseline are both accessed by _id only.
}

console.log(`Sampling ${SAMPLE_SIZE} coordinates for the amenity baseline...`);
const quotas = await boroughQuotas({ size: SAMPLE_SIZE, cutoffISO: CUTOFF, timeoutMs: SAMPLING_TIMEOUT_MS });
const sample = await sampleCoordinates({
  quotas,
  types: ALL_COMPLAINT_TYPES,
  label: "all complaint types (amenity baseline)",
  cutoffISO: CUTOFF,
  rand,
  timeoutMs: SAMPLING_TIMEOUT_MS,
});

console.log(
  `\n=== Measuring amenity distances at ${sample.length} points ` +
    `(live Google Routes correction, paced ${AMENITY_BASELINE_ROUTE_PACING_MS}ms apart, ` +
    `${AMENITY_BASELINE_ROUTE_RETRIES} retries on 429/5xx) ===`
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const metersByBucket = Object.fromEntries(
  Object.values(AMENITY_BUCKET_NAMES).flat().map((bucket) => [bucket, []])
);

let usable = 0;
for (const [index, point] of sample.entries()) {
  if (index > 0) await sleep(AMENITY_BASELINE_ROUTE_PACING_MS);
  const metrics = await getAmenityMetrics(point.lat, point.lng, {
    routeRetries: AMENITY_BASELINE_ROUTE_RETRIES,
  });
  if (!metrics) continue;
  usable++;
  for (const [tierName, { buckets }] of Object.entries(AMENITY_TIERS)) {
    const tierMetrics = metrics[tierName];
    if (!tierMetrics) continue;
    for (const bucket of buckets) {
      const meters = tierMetrics[bucket]?.meters;
      // Imputed to the cap, not skipped — see this script's header.
      metersByBucket[bucket].push(meters ?? AMENITY_MAX_METERS);
    }
  }
}

if (usable < sample.length * 0.7) {
  throw new Error(
    `only ${usable}/${sample.length} points returned amenity metrics — ` +
      `the amenity datasets are probably missing or invalid. Not writing a baseline from this. ` +
      `Run \`npm run build:amenities\` first.`
  );
}

const perBucket = summarize(metersByBucket);

const doc = {
  _id: AMENITY_BASELINE_ID,
  perBucket,
  sampleSize: usable,
  sampleRequested: SAMPLE_SIZE,
  maxMeters: AMENITY_MAX_METERS,
  computedAt: new Date().toISOString(),
};

console.log("\n=== Amenity baseline (metres) ===");
console.log(
  `  ${"bucket".padEnd(16)} ${"median".padStart(7)} ${"p90".padStart(7)}` +
    ` ${"mean".padStart(8)} ${"max".padStart(7)} ${"zero%".padStart(7)}`
);
for (const [tierName, { buckets }] of Object.entries(AMENITY_TIERS)) {
  console.log(`  -- ${tierName} (n=${usable})`);
  for (const bucket of buckets) {
    const stats = perBucket[bucket];
    console.log(
      `  ${bucket.padEnd(16)} ${String(stats.median).padStart(7)}` +
        ` ${String(stats.p90).padStart(7)} ${String(stats.mean).padStart(8)}` +
        ` ${String(stats.max).padStart(7)} ${(stats.zeroShare * 100).toFixed(0).padStart(6)}%`
    );
  }
}

if (DRY_RUN) {
  console.log("\n--dry-run: nothing written.");
} else {
  await mkdir(path.dirname(AMENITY_BASELINE_FILE_PATH), { recursive: true });
  await writeFile(AMENITY_BASELINE_FILE_PATH, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nWrote ${AMENITY_BASELINE_FILE_PATH} — COMMIT THIS FILE.`);

  const savedToMongo = await saveAmenityBaseline(doc);
  console.log(
    savedToMongo
      ? `Wrote amenity baseline document _id="${AMENITY_BASELINE_ID}" to Mongo.`
      : "Mongo not written (unconfigured or unreachable) — the committed file is enough to serve scores."
  );
}

await closeMongo();
console.log(`\nDone: ${usable} points measured against the local amenity datasets.`);
