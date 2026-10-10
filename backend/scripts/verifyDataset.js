/**
 * Verifies our assumptions about the live 311 dataset — CLAUDE.md open items 2-4.
 * Re-runnable: if scores ever look wrong, run this first to check whether the
 * dataset moved under us (Socrata has renamed and re-scoped this UID before).
 *
 *   node scripts/verifyDataset.js
 *
 * Checks:
 *   2. `location` is the geo-typed column within_circle() accepts
 *   3. null-geocoding rate PER BUCKET (not per string — buckets are what score)
 *      and that every EXCLUDED_DESCRIPTORS entry still matches rows
 *   4. current dataset title + actual date range
 */

import {
  SOCRATA_ENDPOINT,
  SOCRATA_DATASET_ID,
  LOCATION_FIELD,
  ALL_COMPLAINT_TYPES,
  EXCLUDED_DESCRIPTORS,
  TYPE_TO_BUCKET,
  WINDOW_MONTHS,
  windowCutoffISO,
} from "../src/config/constants.js";
import { typeInClause } from "../src/providers/socrata.js";

const APP_TOKEN = process.env.SOCRATA_APP_TOKEN;

async function query(params) {
  const headers = APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {};
  const res = await fetch(`${SOCRATA_ENDPOINT}?${new URLSearchParams(params)}`, {
    headers,
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

function quoteList(types) {
  return types.map((t) => `'${t.replace(/'/g, "''")}'`).join(",");
}

// --- Item 4: dataset identity -----------------------------------------------

async function checkDatasetIdentity() {
  console.log("=== Item 4: dataset identity ===");
  const res = await fetch(
    `https://api.us.socrata.com/api/catalog/v1?ids=${SOCRATA_DATASET_ID}`
  );
  const meta = (await res.json()).results?.[0]?.resource;
  console.log(`  title:     ${meta?.name}`);
  console.log(`  updatedAt: ${meta?.updatedAt}`);

  const [oldest] = await query({
    $select: "min(created_date) AS oldest, max(created_date) AS newest",
  });
  console.log(`  earliest created_date: ${oldest.oldest}`);
  console.log(`  latest created_date:   ${oldest.newest}`);
}

// --- Item 2: geo column ------------------------------------------------------

async function checkGeoColumn() {
  console.log(`\n=== Item 2: within_circle on '${LOCATION_FIELD}' ===`);
  const [row] = await query({
    $select: "count(*)",
    $where: `within_circle(${LOCATION_FIELD}, 40.7484, -73.9857, 350)`,
  });
  console.log(`  OK — 350m circle around Empire State returns ${row.count} rows`);
}

// --- Item 3: null-geocoding rate per bucket ----------------------------------

async function checkNullGeocoding() {
  const cutoff = windowCutoffISO();
  console.log(`\n=== Item 3: null-geocoding, trailing ${WINDOW_MONTHS}mo (> ${cutoff}) ===`);

  const rows = await query({
    $select: `complaint_type, count(*) AS total, count(${LOCATION_FIELD}) AS geocoded`,
    // The same filter scoring uses, so these are the rows that actually count.
    $where: `${typeInClause(ALL_COMPLAINT_TYPES)} AND created_date > '${cutoff}'`,
    $group: "complaint_type",
    $limit: "500",
  });

  const buckets = {};
  for (const r of rows) {
    const bucket = TYPE_TO_BUCKET[r.complaint_type];
    if (!bucket) {
      console.log(`  UNMAPPED complaint_type returned: ${r.complaint_type}`);
      continue;
    }
    buckets[bucket] ??= { total: 0, geocoded: 0, variants: 0 };
    buckets[bucket].total += Number(r.total);
    buckets[bucket].geocoded += Number(r.geocoded);
    buckets[bucket].variants += 1;
  }

  console.log("\n  per string:");
  for (const r of [...rows].sort((a, b) => Number(b.total) - Number(a.total))) {
    const nullPct = (100 * (1 - r.geocoded / r.total)).toFixed(2);
    console.log(
      `    ${r.complaint_type.padEnd(26)} n=${String(r.total).padStart(8)}  null=${nullPct.padStart(6)}%`
    );
  }

  console.log("\n  PER BUCKET (what scoring uses):");
  for (const [bucket, v] of Object.entries(buckets)) {
    const nullPct = 100 * (1 - v.geocoded / v.total);
    const flag = nullPct > 10 ? "  <-- UNRELIABLE" : "";
    console.log(
      `    ${bucket.padEnd(22)} n=${String(v.total).padStart(9)}  null=${nullPct
        .toFixed(2)
        .padStart(6)}%  variants=${v.variants}${flag}`
    );
  }

  const seen = new Set(rows.map((r) => r.complaint_type));
  const missing = ALL_COMPLAINT_TYPES.filter((t) => !seen.has(t));
  console.log(
    `\n  types in constants.js with ZERO rows in window: ${
      missing.length ? missing.join(", ") : "(none)"
    }`
  );
}

// An exclusion that matches nothing (a renamed descriptor) would silently let
// those rows back into the score, so each one must still have rows to exclude.
async function checkExcludedDescriptors() {
  const cutoff = windowCutoffISO();
  console.log("\n=== Excluded descriptors, rows each one removes ===");
  for (const [type, descriptors] of Object.entries(EXCLUDED_DESCRIPTORS)) {
    const rows = await query({
      $select: "descriptor, count(*) AS n",
      $where: `complaint_type = '${type}' AND descriptor in (${quoteList(descriptors)}) AND created_date > '${cutoff}'`,
      $group: "descriptor",
    });
    const found = new Map(rows.map((r) => [r.descriptor, Number(r.n)]));
    for (const descriptor of descriptors) {
      const n = found.get(descriptor) ?? 0;
      console.log(`  ${type} / ${descriptor}: ${n}${n === 0 ? "  <-- MATCHES NOTHING" : ""}`);
    }
  }
}

await checkDatasetIdentity();
await checkGeoColumn();
await checkNullGeocoding();
await checkExcludedDescriptors();
