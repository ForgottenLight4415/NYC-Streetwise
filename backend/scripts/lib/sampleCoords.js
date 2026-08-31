/**
 * Shared candidate-coordinate sampler, extracted from buildBaseline.js so
 * buildAmenityBaseline.js can draw the SAME kind of borough-quota'd, thinned
 * sample without duplicating the logic. Every function here is unchanged in
 * behaviour from what buildBaseline.js used to do inline — see its own header
 * for the full rationale (why building/block need separate sample sources,
 * why borough quotas have a floor, why thinning exists, why the RNG is seeded).
 *
 * The RNG is a PARAMETER, not module state: callers create their own
 * `seededRandom(seed)` instance and thread it through every call for one
 * script's run. This is what keeps buildBaseline.js byte-for-byte reproducible
 * across the refactor — its existing single RNG stream, drawn from in the same
 * order (building's chunks, then block's), is preserved exactly. A shared
 * module-scope RNG would have let two unrelated scripts' random draws
 * interfere with each other's determinism.
 */

import { query } from "../../src/providers/socrata.js";
import {
  BASELINE_MIN_BOROUGH_SHARE,
  BASELINE_THINNING_GRID_DEGREES,
  BOROUGHS,
  LOCATION_FIELD,
  ALL_COMPLAINT_TYPES,
} from "../../src/config/constants.js";

/** Mulberry32. Seeded so a rerun samples the SAME points and hits the cache. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const typeInClause = (types) => `complaint_type in (${types.map(quote).join(",")})`;

/**
 * Quotas proportional to each borough's share of 311 records overall, with a
 * floor. Pure proportional sampling would nearly erase Staten Island; pure
 * equal sampling would over-represent it. Tier-agnostic — the SAME quotas are
 * used whichever tier's coordinates end up drawn against them, since they
 * describe the city's population distribution, not a bucket's.
 */
export async function boroughQuotas({ size, cutoffISO, minBoroughShare = BASELINE_MIN_BOROUGH_SHARE, timeoutMs = 30000 }) {
  const rows = await query(
    {
      $select: "borough, count(*) AS count",
      $where: [typeInClause(ALL_COMPLAINT_TYPES), `created_date > ${quote(cutoffISO)}`].join(" AND "),
      $group: "borough",
    },
    { timeoutMs }
  );

  const counts = new Map(
    rows.filter((row) => BOROUGHS.includes(row.borough)).map((row) => [row.borough, Number(row.count)])
  );
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

  const remaining = 1 - minBoroughShare * BOROUGHS.length;
  const quotas = BOROUGHS.map((borough) => {
    const share = total === 0 ? 1 / BOROUGHS.length : (counts.get(borough) ?? 0) / total;
    return [borough, Math.max(1, Math.round(size * (minBoroughShare + remaining * share)))];
  });

  console.log("=== Borough quotas ===");
  for (const [borough, quota] of quotas) {
    const share = total === 0 ? 0 : ((counts.get(borough) ?? 0) / total) * 100;
    console.log(
      `  ${borough.padEnd(14)} ${String(quota).padStart(4)} points   (${share.toFixed(1)}% of records)`
    );
  }
  return quotas;
}

/**
 * Candidate coordinates for one borough, pulled from several random slices of
 * the time window rather than one contiguous page — deep $offset paging is
 * slow at this dataset size, and random date slices spread the sample
 * temporally as well as spatially.
 */
export async function candidateCoords({
  borough,
  wanted,
  types,
  rand,
  cutoffISO,
  chunksPerBorough = 5,
  chunkWindowDays = 21,
  oversample = 6,
  timeoutMs = 30000,
}) {
  const cutoffMs = new Date(`${cutoffISO}Z`).getTime();
  const windowMs = Date.now() - cutoffMs;
  const sliceMs = chunkWindowDays * 24 * 60 * 60 * 1000;
  const perChunk = Math.ceil((wanted * oversample) / chunksPerBorough);

  const coords = [];
  for (let chunk = 0; chunk < chunksPerBorough; chunk++) {
    const start = cutoffMs + rand() * Math.max(0, windowMs - sliceMs);
    const startISO = new Date(start).toISOString().slice(0, 19);
    const endISO = new Date(start + sliceMs).toISOString().slice(0, 19);

    const rows = await query(
      {
        $select: "latitude, longitude",
        $where: [
          `borough = ${quote(borough)}`,
          typeInClause(types),
          `created_date between ${quote(startISO)} and ${quote(endISO)}`,
          `${LOCATION_FIELD} IS NOT NULL`,
        ].join(" AND "),
        // Deliberately UNORDERED — see buildBaseline.js's header for the
        // measured cost of $order on this filter (9.7s vs 0.23s).
        $limit: String(perChunk),
      },
      { timeoutMs }
    );

    for (const row of rows) {
      const lat = Number(row.latitude);
      const lng = Number(row.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) coords.push({ lat, lng });
    }
  }
  return coords;
}

/**
 * Keeps at most one point per grid cell, so one complaint-dense building
 * cannot contribute dozens of near-identical points.
 */
export function thin(coords, gridDegrees = BASELINE_THINNING_GRID_DEGREES) {
  const seen = new Set();
  const kept = [];
  for (const coord of coords) {
    const cell = `${Math.round(coord.lat / gridDegrees)}:${Math.round(coord.lng / gridDegrees)}`;
    if (seen.has(cell)) continue;
    seen.add(cell);
    kept.push(coord);
  }
  return kept;
}

/**
 * Full sample across every borough: candidateCoords + thin + shuffle-and-slice
 * to quota, per borough, in order. `rand` threads through every borough's
 * candidateCoords AND shuffle call — callers that need reproducibility across
 * a whole script run must pass the SAME rand instance to every call they make.
 */
export async function sampleCoordinates({ quotas, types, label, cutoffISO, rand, ...rest }) {
  const sample = [];
  console.log(`\n=== Sampling coordinates from ${label} ===`);
  for (const [borough, quota] of quotas) {
    const candidates = await candidateCoords({ borough, wanted: quota, types, rand, cutoffISO, ...rest });
    const thinned = thin(candidates);
    const picked = shuffle(thinned, rand).slice(0, quota);
    sample.push(...picked.map((coord) => ({ ...coord, borough })));
    console.log(
      `  ${borough.padEnd(14)} ${String(candidates.length).padStart(5)} candidates` +
        ` -> ${String(thinned.length).padStart(4)} after thinning` +
        ` -> ${String(picked.length).padStart(4)} sampled`
    );
  }
  return sample;
}
