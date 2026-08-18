import {
  RADIUS_TIERS,
  COMPLAINTS_DEFAULT_LIMIT,
  COMPLAINT_GROUPS_CACHE_LIMIT,
  STATUS_BUCKET_NAMES,
  TYPE_TO_BUCKET,
  EXPLANATION_SOURCES,
  statusBucket,
} from "../config/constants.js";
import {
  fetchCountsForTier,
  fetchComplaints,
  fetchComplaintGroups,
  fetchComplaintsForGroup,
  fetchMonthlyTrend,
} from "../providers/socrata.js";
import {
  readEntries,
  writeCounts,
  writeExplanation,
  readTrend,
  writeTrend,
  readComplaintGroups,
  writeComplaintGroups,
  roundCoord,
} from "../providers/cache.js";
import { loadBaseline } from "../providers/baseline.js";
import { buildReport, scoreTier } from "./scoring.js";
import { explainFromTemplate, explainWithAI } from "./explain.js";
import { mockScoreReport, mockComplaints, mockMonthlyTrend } from "./mockData.js";

// Orchestration: cache first, Socrata on a miss, write the result back.
// The routes never call Socrata or Mongo directly — that separation is what
// lets this be tested with a fake fetch and an in-memory Mongo.

const ALL_TIERS = Object.keys(RADIUS_TIERS);

/**
 * Bucket counts for both radius tiers around one point.
 *
 * The Socrata query uses the ROUNDED coordinate, not the caller's raw one. If it
 * used the raw coordinate, two addresses sharing a cache key would get whichever
 * circle happened to be queried first — a cache hit and a cache miss would then
 * describe measurably different circles. Rounding first makes the key and the
 * query agree, at the cost of moving the centre by up to ~8m (4dp ≈ 11m, well
 * inside the 25m building radius).
 *
 * Misses are fetched in parallel, so an uncached point still costs the two HTTP
 * calls CLAUDE.md budgets — never more.
 *
 * @returns {Promise<{coord: {lat, lng}, counts: Record<string, object>,
 *   cache: Record<string, "hit"|"miss">}>}
 */
export async function getCounts(lat, lng, { now, tiers = ALL_TIERS, forceRefresh = false } = {}) {
  const coord = { lat: roundCoord(lat), lng: roundCoord(lng) };

  const entries = forceRefresh
    ? Object.fromEntries(tiers.map((tier) => [tier, null]))
    : await readEntries(coord.lat, coord.lng, tiers);

  // Any explanation cached alongside the counts. Returned so the score path can
  // serve a stored AI explanation without ever making an AI call itself.
  const cachedExplanations = Object.fromEntries(
    tiers.map((tier) => [tier, entries[tier] ?? null])
  );

  const cached = Object.fromEntries(
    tiers.map((tier) => [tier, entries[tier]?.counts ?? null])
  );

  const misses = tiers.filter((tier) => cached[tier] === null);

  // allSettled, not all: Promise.all short-circuits on the first rejection, so a
  // failing building tier would abandon the block tier mid-write and throw away
  // a call that had already succeeded. Letting both settle means a retry after a
  // partial failure only pays for the tier that actually failed.
  const settled = await Promise.allSettled(
    misses.map(async (tier) => {
      const counts = await fetchCountsForTier(coord.lat, coord.lng, tier, { now });
      // Awaited, not fire-and-forget: an unawaited rejection would surface as an
      // unhandled rejection, and on serverless the process can exit first.
      // writeCounts never throws, so this cannot fail the request.
      await writeCounts(coord.lat, coord.lng, tier, counts, { now });
      return [tier, counts];
    })
  );

  const failure = settled.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;

  const counts = {
    ...cached,
    ...Object.fromEntries(settled.map((outcome) => outcome.value)),
  };

  return {
    coord,
    counts,
    cachedExplanations,
    cache: Object.fromEntries(
      tiers.map((tier) => [tier, misses.includes(tier) ? "miss" : "hit"])
    ),
  };
}

/**
 * Mock mode is opt-in and off by default. It stays in the codebase after M5
 * because it is the only way to develop the frontend with no Socrata token, no
 * Mongo, and no network — and because it is the fallback if the live API is
 * down while someone is working on layout. Read at call time so a test can flip
 * it without re-importing the module.
 */
export function isMockMode() {
  return process.env.USE_MOCK_DATA === "1" || process.env.USE_MOCK_DATA === "true";
}

/**
 * The full POST /api/score payload: counts (cache-first) scored against the
 * citywide baseline.
 *
 * The baseline load is issued alongside the counts rather than after them —
 * it is memoized and usually free, but on the first request of a cold process
 * it is a Mongo round trip that has no reason to sit behind two HTTP calls.
 */
export async function buildScoreReport(lat, lng, options = {}) {
  if (isMockMode()) return mockScoreReport(lat, lng);

  const [{ coord, counts, cache, cachedExplanations }, baseline] =
    await Promise.all([getCounts(lat, lng, options), loadBaseline()]);

  const report = buildReport(counts, baseline, {
    // Coordinates are rounded for the cache key, so the circle we actually
    // queried is not exactly the one asked for. Say so rather than implying
    // more precision than we have.
    coord,
    cache,
  });

  // Explanations are attached here, and NEVER generated here. This endpoint is
  // on the user's critical path; the AI call is not allowed anywhere near it.
  // A cached AI explanation is served if one exists, otherwise the deterministic
  // template goes out immediately and the frontend asks /api/explanation for
  // the real thing.
  for (const [tier, key] of Object.entries(REPORT_KEYS)) {
    report[key] = {
      ...report[key],
      ...resolveCachedExplanation(tier, report[key], cachedExplanations?.[tier]),
    };
  }

  return report;
}

/** Which response key each radius tier lands under. */
const REPORT_KEYS = {
  building: "buildingHealth",
  block: "blockQuality",
};

/**
 * Uses a cached AI explanation when one is stored, otherwise falls back to the
 * template. Only "ai" is accepted from cache: a cached *template* string is
 * worth nothing (we can rebuild it for free) and storing it would make the
 * frontend think the AI had already run and skip its second call.
 */
function resolveCachedExplanation(tier, subScore, cached) {
  if (
    cached?.explanationSource === EXPLANATION_SOURCES.ai &&
    typeof cached.explanation === "string" &&
    cached.explanation !== ""
  ) {
    return {
      explanation: cached.explanation,
      explanationSource: EXPLANATION_SOURCES.ai,
    };
  }
  return explainFromTemplate(tier, subScore);
}

/**
 * The SLOW path behind GET /api/explanation: generate one tier's explanation
 * with the active AI adapter, store it next to the counts, return it.
 *
 * Separated from the score request precisely so the AI latency gets its own
 * request budget instead of stacking behind Socrata + scoring — which is what
 * would blow a serverless execution cap.
 *
 * Returns a cached AI explanation immediately if one already exists, so a
 * double-fire from the frontend costs a Mongo read rather than a generation.
 *
 * @returns {Promise<{explanation, explanationSource, band, cached: boolean}>}
 */
export async function buildExplanation(lat, lng, tier, options = {}) {
  const [{ coord, counts, cachedExplanations }, baseline] = await Promise.all([
    getCounts(lat, lng, { ...options, tiers: [tier] }),
    loadBaseline(),
  ]);

  const subScore = scoreTier(tier, counts[tier], baseline);
  const cached = cachedExplanations?.[tier];

  if (
    cached?.explanationSource === EXPLANATION_SOURCES.ai &&
    typeof cached.explanation === "string" &&
    cached.explanation !== ""
  ) {
    return {
      explanation: cached.explanation,
      explanationSource: EXPLANATION_SOURCES.ai,
      band: subScore.band,
      cached: true,
    };
  }

  const { explanation, explanationSource } = await explainWithAI(tier, subScore);

  // Only AI output is worth storing — see resolveCachedExplanation. Awaited so
  // a serverless process cannot exit before the write lands, and it cannot
  // throw, so it cannot fail the request.
  if (explanationSource === EXPLANATION_SOURCES.ai) {
    await writeExplanation(coord.lat, coord.lng, tier, explanation, explanationSource);
  }

  return { explanation, explanationSource, band: subScore.band, cached: false };
}

/**
 * Individual complaint points for the frontend heatmap.
 *
 * NOT cached: the cache stores bucket counts, not rows, and caching thousands
 * of points per coordinate is what CLAUDE.md's "no bulk ingest" rule exists to
 * prevent. The heatmap is a secondary view; the score is what must be fast.
 */
export async function fetchComplaintPoints(lat, lng, radiusMeters, options = {}) {
  if (isMockMode()) {
    const points = mockComplaints(lat, lng, radiusMeters).map(withStatusBucket);
    return { points, truncated: false, limit: points.length };
  }

  const limit = options.limit ?? COMPLAINTS_DEFAULT_LIMIT;
  const points = await fetchComplaints(lat, lng, radiusMeters, { ...options, limit });

  return {
    points,
    // Socrata returns the most recent `limit` rows, so a dense block silently
    // loses its older months. The caller reports this to the client rather than
    // presenting a truncated slice as if it were the whole window.
    truncated: points.length >= limit,
    limit,
  };
}

/** Mock rows carry a raw status only; give them the same shape as live rows. */
function withStatusBucket(point) {
  return { ...point, statusBucket: statusBucket(point.status) };
}

/** "YYYY-MM-DD" for `months` months before the reference date. */
function dayCutoff(months, now) {
  const d = new Date(now ?? Date.now());
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function zeroStatusCounts() {
  return Object.fromEntries(STATUS_BUCKET_NAMES.map((name) => [name, 0]));
}

/**
 * One row per (day, complaint_type) for the complaints browser, newest first,
 * with a status breakdown inside each row.
 *
 * Cache-first over GROUPED rows, which is what makes this affordable. The raw
 * listing path can never answer these questions on a busy block: 655 E 230 St
 * has 190,205 rows inside a 350m/24mo window, past Socrata's own $limit — but
 * only 1,848 grouped rows.
 *
 * `total` counts distinct (day, type) pairs after filtering — GROUPS, not the
 * complaints inside them. Paging is over groups too.
 */
export async function fetchComplaintGroupList(
  lat,
  lng,
  radiusMeters,
  { tier, months, bucket, status, offset = 0, limit = 25, now } = {}
) {
  let groups;
  let truncated = false;
  let cached = false;

  if (isMockMode()) {
    groups = groupMockComplaints(lat, lng, radiusMeters);
  } else {
    // The cache key has no radius dimension, so an ad-hoc radius must neither
    // read from nor write to it — it would collide with the tier's own entry
    // and describe a different circle.
    const cacheable = Boolean(tier) && radiusMeters === RADIUS_TIERS[tier].radiusMeters;

    if (cacheable) {
      const hit = await readComplaintGroups(lat, lng, tier);
      if (hit) {
        ({ groups, truncated } = hit);
        cached = true;
      }
    }

    if (!groups) {
      // Always filled at the CACHE limit, never the caller's page size —
      // otherwise a limit=25 request would store a 25-row entry that every
      // later page has to discard.
      groups = await fetchComplaintGroups(lat, lng, radiusMeters, {
        tier,
        now,
        limit: COMPLAINT_GROUPS_CACHE_LIMIT,
      });
      truncated = groups.length >= COMPLAINT_GROUPS_CACHE_LIMIT;
      if (cacheable) {
        // AWAITED, unlike writeTrend's fire-and-forget. That one follows a fast
        // query and must not delay a chart; this one follows a fill measured at
        // 2.3-74.3s, so a few milliseconds of Mongo write is noise — and losing
        // the race means paying that fill a second time. Still never throws: a
        // failed write costs a repeat fill, not a request.
        await writeComplaintGroups(lat, lng, tier, groups, truncated).catch(() => {});
      }
    }
  }

  const cutoff = months ? dayCutoff(months, now) : null;
  const matching = groups.filter((g) => {
    if (cutoff && g.day < cutoff) return false;
    if (bucket && TYPE_TO_BUCKET[g.type] !== bucket) return false;
    if (status && g.statusBucket !== status) return false;
    return true;
  });

  // Collapse the (day, type, status) tuples into one row per (day, type). Under
  // a status filter the non-matching tuples are already gone, so a row whose
  // only complaints were of another status never gets created.
  const byKey = new Map();
  for (const g of matching) {
    const key = `${g.day}|${g.type}`;
    let row = byKey.get(key);
    if (!row) {
      row = { day: g.day, type: g.type, counts: zeroStatusCounts(), total: 0 };
      byKey.set(key, row);
    }
    row.counts[g.statusBucket] += g.count;
    row.total += g.count;
  }

  // Sorted explicitly rather than trusting Socrata's grouping order: paging is
  // offset-based, so an unstable order would duplicate and drop rows between
  // pages.
  const rows = [...byKey.values()].sort(
    (a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.type.localeCompare(b.type))
  );

  return {
    rows: rows.slice(offset, offset + limit),
    total: rows.length,
    hasMore: offset + limit < rows.length,
    truncated,
    cached,
    offset,
    limit,
  };
}

/** Groups the deterministic mock rows the same way Socrata's $group would. */
function groupMockComplaints(lat, lng, radiusMeters) {
  const byKey = new Map();
  for (const point of mockComplaints(lat, lng, radiusMeters)) {
    const day = point.created_date.slice(0, 10);
    const key = `${day}|${point.type}|${statusBucket(point.status)}`;
    const existing = byKey.get(key);
    if (existing) existing.count += 1;
    else {
      byKey.set(key, {
        day,
        type: point.type,
        statusBucket: statusBucket(point.status),
        count: 1,
      });
    }
  }
  return [...byKey.values()];
}

/**
 * The individual complaints behind one (day, type) group.
 *
 * Live and uncached: a rare, explicit drill-in, and the cost is the spatial
 * filter rather than the rows (5.6s measured for a 17-row day), so a day+type
 * cache would buy little for the upkeep of another collection.
 */
export async function fetchComplaintGroupDetail(
  lat,
  lng,
  radiusMeters,
  { type, day, status, offset = 0, limit = 50 } = {}
) {
  if (isMockMode()) {
    const all = mockComplaints(lat, lng, radiusMeters)
      .map(withStatusBucket)
      .filter((p) => p.type === type && p.created_date.slice(0, 10) === day)
      .filter((p) => !status || p.statusBucket === status);
    return {
      points: all.slice(offset, offset + limit),
      total: all.length,
      hasMore: offset + limit < all.length,
    };
  }

  // One extra row is the cheapest possible "is there another page?" probe, and
  // it avoids a second count query against the slowest part of the upstream.
  const points = await fetchComplaintsForGroup(lat, lng, radiusMeters, {
    type,
    day,
    offset,
    limit: limit + 1,
  });

  const hasMore = points.length > limit;
  const page = hasMore ? points.slice(0, limit) : points;

  return {
    // Filtered after the fetch, not in SoQL: `status` is our three-way bucket,
    // not a dataset value, and expanding it back into raw statuses inside the
    // query would put a second copy of the enum in the where-clause.
    points: status ? page.filter((p) => p.statusBucket === status) : page,
    total: null, // the caller already knows the group's size from the list
    hasMore,
  };
}

/**
 * Complaints per month for one tier over the last `months` months, oldest
 * first and zero-filled.
 *
 * Zero-filling happens here rather than in the provider because "no complaints
 * that month" is a real, chartable value, while Socrata simply omits the row —
 * a gap-free series is what every caller wants and none should have to
 * reconstruct.
 */
export async function fetchTrend(lat, lng, radiusMeters, { tier, months, now } = {}) {
  const reference = new Date(now ?? Date.now());

  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(reference.getFullYear(), reference.getMonth() - i, 1);
    buckets.push({
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      count: 0,
    });
  }

  if (isMockMode()) {
    return fill(buckets, mockMonthlyTrend(lat, lng, radiusMeters, { tier, months, now: reference }));
  }

  // Cache the finished series, not the raw rows: it is small (≤24 numbers), and
  // the block-tier query is the slowest call in the app — 13s cold on a dense
  // block, which is inside the Socrata retry budget but outside a serverless
  // function's. The cached path is the one that has to hold up in production.
  const cached = await readTrend(lat, lng, tier, months);
  if (cached) return cached;

  const points = await fetchMonthlyTrend(lat, lng, radiusMeters, {
    tier,
    months,
    now: reference,
  });
  const series = fill(buckets, points);

  // Not awaited into the response path — a slow cache write must not delay the
  // chart, and a failed one costs a repeat query, not a request.
  writeTrend(lat, lng, tier, months, series).catch(() => {});

  return series;
}

/** Drops each returned month into its slot, ignoring anything out of range. */
function fill(buckets, points) {
  const indexByMonth = new Map(buckets.map((b, i) => [b.month, i]));
  for (const point of points) {
    const idx = indexByMonth.get(point.month);
    if (idx !== undefined) buckets[idx].count = point.count;
  }
  return buckets;
}
