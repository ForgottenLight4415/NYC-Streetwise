/**
 * Markdown table of how the complaint baseline moved between two builds.
 *
 *   node scripts/baselineDiff.js <old baseline.json> <new baseline.json>
 *
 * Written for the monthly baseline PR (.github/workflows/monthly-baseline.yml),
 * where it is the thing a reviewer actually reads: every score is a percentile
 * against these anchors, so a bucket whose median jumps is a bucket whose
 * scores all move. A move past FLAG_RATIO is marked for a closer look; a
 * sudden jump is more often an upstream data problem (a Socrata outage, a
 * renamed complaint type) than a real change in the city.
 */

import { readFile } from "node:fs/promises";
import { BUCKET_NAMES } from "../src/config/constants.js";

const FLAG_RATIO = 0.25;

const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error("usage: node scripts/baselineDiff.js <old.json> <new.json>");
  process.exit(1);
}

const [before, after] = await Promise.all(
  [oldPath, newPath].map(async (file) => JSON.parse(await readFile(file, "utf8")))
);

/** "32 → 35 (+9%)", or just "32" when unchanged. */
function change(from, to) {
  if (from === undefined) return `${to} (new)`;
  if (from === to) return String(to);
  const pct = from === 0 ? null : Math.round(((to - from) / from) * 100);
  return `${from} → ${to}${pct === null ? "" : ` (${pct > 0 ? "+" : ""}${pct}%)`}`;
}

function moved(from, to) {
  if (from === undefined) return false;
  if (from === 0) return to !== 0;
  return Math.abs(to - from) / from > FLAG_RATIO;
}

const lines = [
  "| Tier | Bucket | Median | p90 | |",
  "|---|---|---|---|---|",
];
let flagged = 0;
for (const [tier, buckets] of Object.entries(BUCKET_NAMES)) {
  for (const bucket of buckets) {
    const from = before.perBucket?.[bucket] ?? {};
    const to = after.perBucket[bucket];
    const flag = moved(from.median, to.median) || moved(from.p90, to.p90);
    if (flag) flagged++;
    lines.push(
      `| ${tier} | \`${bucket}\` | ${change(from.median, to.median)} | ` +
        `${change(from.p90, to.p90)} | ${flag ? "⚠️" : ""} |`
    );
  }
}

console.log(lines.join("\n"));
console.log(
  flagged
    ? `\n⚠️ ${flagged} bucket(s) moved more than ${FLAG_RATIO * 100}%. Check for an upstream data problem before merging.`
    : `\nNo bucket moved more than ${FLAG_RATIO * 100}%.`
);
console.log(
  `\nSample: ${after.sampleSize} points per tier, ${after.windowMonths}-month window, ` +
    `computed ${after.computedAt}.`
);
