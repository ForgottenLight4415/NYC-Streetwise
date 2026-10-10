/**
 * Does the score actually DISCRIMINATE, and is it centred where we claim?
 *
 *   yarn verify:scoring
 *
 * The unit tests prove the maths is right for fixtures. They cannot tell you
 * that the scale is useful — a scorer that returns "fair" for all of NYC would
 * pass every one of them. This re-scores every coordinate already in the cache
 * (the baseline run leaves ~250 there) against the committed baseline and prints
 * the resulting distribution.
 *
 * No network: it reads the cache and the baseline, nothing else. If the cache is
 * empty, run `yarn baseline` first.
 *
 * What to look for:
 *   - all three bands present on both tiers, none swallowing everything
 *   - the median score near 50 for the block tier (that is what the baseline is for)
 *   - the loud/quiet landmarks landing in the right order
 */

import {
  CACHE_COLLECTION,
  BUCKET_NAMES,
  RADIUS_TIERS,
  BAND_THRESHOLDS,
} from "../src/config/constants.js";
import { getDb, closeMongo, isMongoConfigured } from "../src/providers/mongo.js";
import { loadBaseline } from "../src/providers/baseline.js";
import { scoreTier } from "../src/services/scoring.js";

if (!isMongoConfigured()) {
  console.error("MONGODB_URI is not set — nothing cached to re-score.");
  process.exit(2);
}

const baseline = await loadBaseline();
if (!baseline) {
  console.error("No baseline found. Run `yarn baseline` first.");
  process.exit(2);
}
console.log(
  `Baseline ${baseline._id} from ${baseline.source}, ` +
    `${baseline.sampleSize ?? "?"} sample points, ` +
    `computed ${baseline.computedAt ?? "unknown"}`
);

const db = await getDb();
const docs = await db.collection(CACHE_COLLECTION).find({}).toArray();

if (docs.length === 0) {
  console.error("\nCache is empty. Run `yarn baseline` first.");
  await closeMongo();
  process.exit(2);
}

// Pair the two tiers back together by coordinate.
const byCoord = new Map();
for (const doc of docs) {
  const key = `${doc.lat},${doc.lng}`;
  if (!byCoord.has(key)) byCoord.set(key, { lat: doc.lat, lng: doc.lng });
  byCoord.get(key)[doc.radiusTier] = doc.counts;
}

const scored = [];
for (const point of byCoord.values()) {
  const entry = { lat: point.lat, lng: point.lng };
  for (const tier of Object.keys(RADIUS_TIERS)) {
    if (point[tier]) entry[tier] = scoreTier(tier, point[tier], baseline);
  }
  scored.push(entry);
}

console.log(`\nRe-scored ${scored.length} cached coordinates.`);
console.log(
  "NOTE: this is whatever is in the cache — baseline sample points plus every\n" +
    "      address anyone has looked up. It is not a clean random sample, so read\n" +
    "      the shape of the distribution, not the exact percentages.\n"
);

function quantile(sorted, fraction) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

let failures = 0;

for (const tier of Object.keys(RADIUS_TIERS)) {
  const tiers = scored.map((entry) => entry[tier]).filter(Boolean);
  if (tiers.length === 0) continue;

  const scores = tiers.map((t) => t.score).sort((a, b) => a - b);
  const bands = { good: 0, fair: 0, poor: 0 };
  let lowConfidence = 0;
  for (const t of tiers) {
    bands[t.band]++;
    if (t.confidence === "low") lowConfidence++;
  }

  console.log(`=== ${tier} (${RADIUS_TIERS[tier].radiusMeters}m, n=${tiers.length}) ===`);
  console.log(
    `  score   min ${scores[0]}  p25 ${quantile(scores, 0.25)}` +
      `  median ${quantile(scores, 0.5)}  p75 ${quantile(scores, 0.75)}` +
      `  max ${scores[scores.length - 1]}`
  );
  console.log(
    `  bands   good ${bands.good}  fair ${bands.fair}  poor ${bands.poor}` +
      `   (thresholds: good>=${BAND_THRESHOLDS.good}, fair>=${BAND_THRESHOLDS.fair})`
  );
  console.log(
    `  low confidence: ${lowConfidence} ` +
      `(${((lowConfidence / tiers.length) * 100).toFixed(1)}%)`
  );

  // Per-bucket spread: a bucket whose scores never move contributes nothing.
  for (const bucket of BUCKET_NAMES[tier]) {
    const values = tiers.map((t) => t.bucketScores[bucket]).sort((a, b) => a - b);
    console.log(
      `    ${bucket.padEnd(20)} median ${String(quantile(values, 0.5)).padStart(3)}` +
        `  range ${values[0]}-${values[values.length - 1]}`
    );
  }

  const checks = [
    ["all three bands are reachable", bands.good > 0 && bands.fair > 0 && bands.poor > 0],
    ["no single band swallows >80% of the city", Object.values(bands).every((n) => n / tiers.length <= 0.8)],
    ["scores span at least half the scale", scores[scores.length - 1] - scores[0] >= 50],
  ];
  for (const [name, ok] of checks) {
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  }
  console.log();
}

// Ordering sanity: the loudest cached block must not outscore the quietest.
const blocks = scored.filter((entry) => entry.block);
if (blocks.length >= 2) {
  const sorted = [...blocks].sort((a, b) => a.block.score - b.block.score);
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];
  console.log("=== Extremes (block tier) ===");
  for (const [label, entry] of [["worst", worst], ["best", best]]) {
    console.log(
      `  ${label.padEnd(6)} ${entry.lat},${entry.lng}  score ${entry.block.score}` +
        ` (${entry.block.band})  counts ${JSON.stringify(entry.block.counts)}`
    );
  }
  const ordered = worst.block.counts.noise > best.block.counts.noise;
  if (!ordered) failures++;
  console.log(`  ${ordered ? "PASS" : "FAIL"}  the worst-scoring block is noisier than the best`);
}

await closeMongo();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
