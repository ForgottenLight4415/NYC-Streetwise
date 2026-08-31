import {
  RADIUS_TIERS,
  COMPLAINTS_DEFAULT_LIMIT,
  COMPLAINT_GROUPS_CACHE_LIMIT,
  STATUS_BUCKET_NAMES,
  TYPE_TO_BUCKET,
  EXPLANATION_SOURCES,
  WALKABILITY_BASELINE_PER_BUCKET,
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
  readAmenityExplanation,
  writeAmenityExplanation,
  readTrend,
  writeTrend,
  readComplaintGroups,
  writeComplaintGroups,
  roundCoord,
} from "../providers/cache.js";
import { loadBaseline } from "../providers/baseline.js";
import { loadAmenityBaseline } from "../providers/amenityBaseline.js";
import { getAmenityMetrics, getWalkabilityMetrics } from "./amenityService.js";
import { buildReport } from "./scoring.js";
import {
  explainFromTemplate,
  explainOverallFromTemplate,
  explainOverallWithAI,
} from "./explain.js";
import { mockScoreReport, mockComplaints, mockMonthlyTrend } from "./mockData.js";

/**
 * Amenity metrics + baseline for one point, NEVER rejecting — an amenity
 * failure (a corrupt dataset, an unreachable Mongo) must degrade the report
 * to buildingHealth/blockQuality only, not fail the whole request. Socrata
 * and Mongo for the complaint side already have their own error handling;
 * this is the amenity side's equivalent backstop. Costs no wall-clock time
 * beyond the complaint path — issued alongside it, not after.
 *
 * Walkability is fetched alongside the three static-dataset tiers and merged
 * in here, rather than inside getAmenityMetrics() itself — it has a
 * genuinely different cost profile (a live, billed, cacheable-per-coordinate
 * call, not a free in-memory lookup), so `cacheOnly` only ever changes ITS
 * behaviour. `amenityBaseline`'s `perBucket` gets walkability's four
 * (reasoned, not sampled — see WALKABILITY_BASELINE_PER_BUCKET) buckets
 * merged in too, so scoreAmenityTier("walkability", ...) finds them the same
 * way it finds subway's or park's, with no special-casing in that function.
 *
 * @param {{cacheOnly?: boolean}} [options] Forwarded to getWalkabilityMetrics
 *   only — see its docstring. The three static tiers have no such concept;
 *   they are already as cheap as a cache read.
 */
async function getAmenitiesForReport(lat, lng, { cacheOnly = false } = {}) {
  const [amenities, walkability, amenityBaseline] = await Promise.all([
    getAmenityMetrics(lat, lng).catch((err) => {
      console.warn("[scoreService] amenity metrics failed, degrading to complaints-only:", err.message);
      return null;
    }),
    getWalkabilityMetrics(lat, lng, { cacheOnly }).catch((err) => {
      console.warn("[scoreService] walkability metrics failed, omitting that section:", err.message);
      return null;
    }),
    loadAmenityBaseline().catch((err) => {
      console.warn("[scoreService] amenity baseline failed:", err.message);
      return null;
    }),
  ]);

  return {
    amenities: { ...amenities, walkability },
    amenityBaseline: amenityBaseline
      ? { ...amenityBaseline, perBucket: { ...amenityBaseline.perBucket, ...WALKABILITY_BASELINE_PER_BUCKET } }
      : { perBucket: WALKABILITY_BASELINE_PER_BUCKET },
  };
}

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
 * `cacheOnly` suppresses the Socrata fallback entirely and leaves a missing
 * tier's counts `null`. That is for callers on a path where a slow answer is
 * worse than no answer — the homepage renders whatever is already cached, and
 * must never pay a 0.3-2.5s (tail 8.3s) upstream call to do it.
 *
 * @returns {Promise<{coord: {lat, lng}, counts: Record<string, object|null>,
 *   bucketStatusCounts: Record<string, object|undefined>,
 *   updatedAt: Record<string, Date|null>,
 *   cache: Record<string, "hit"|"miss">}>}
 */
export async function getCounts(
  lat,
  lng,
  { now, tiers = ALL_TIERS, forceRefresh = false, cacheOnly = false } = {}
) {
  const coord = { lat: roundCoord(lat), lng: roundCoord(lng) };
  // Resolved ONCE, up front, rather than defaulted separately wherever `now`
  // is used below. A miss's `updatedAt` entry must be the EXACT timestamp
  // writeCounts persists as that document's `createdAt` — two independently
  // evaluated `new Date()` calls, even microseconds apart, would make a
  // freshly-written tier register as already stale to
  // resolveCachedOverallSummary's exact-timestamp comparison.
  const effectiveNow = now ?? new Date();

  const entries = forceRefresh
    ? Object.fromEntries(tiers.map((tier) => [tier, null]))
    : await readEntries(coord.lat, coord.lng, tiers);

  const cached = Object.fromEntries(
    tiers.map((tier) => [tier, entries[tier]?.counts ?? null])
  );

  // Status breakdown travels alongside counts the same way, but is never
  // defaulted to a zero-filled object: `undefined` here means "not computed
  // for this tier" (an older cache doc), which is a different fact from
  // "every status bucket really is zero".
  const cachedStatusCounts = Object.fromEntries(
    tiers.map((tier) => [tier, entries[tier]?.bucketStatusCounts ?? undefined])
  );

  // When each tier's counts were last (re)written. Used by
  // resolveCachedOverallSummary to tell whether the cached whole-report
  // summary — a SEPARATE document on its own TTL — describes THESE counts or
  // an earlier version of them that has since been refreshed.
  const updatedAt = Object.fromEntries(
    tiers.map((tier) => [tier, entries[tier]?.createdAt ?? null])
  );

  const misses = tiers.filter((tier) => cached[tier] === null);

  // A cache-only caller stops here. Reported as a "miss" rather than an error:
  // nothing went wrong, the answer simply is not stored yet, and the caller
  // decides what to show for a null.
  if (cacheOnly) {
    return {
      coord,
      counts: cached,
      bucketStatusCounts: cachedStatusCounts,
      updatedAt,
      cache: Object.fromEntries(
        tiers.map((tier) => [tier, misses.includes(tier) ? "miss" : "hit"])
      ),
    };
  }

  // allSettled, not all: Promise.all short-circuits on the first rejection, so a
  // failing building tier would abandon the block tier mid-write and throw away
  // a call that had already succeeded. Letting both settle means a retry after a
  // partial failure only pays for the tier that actually failed.
  const settled = await Promise.allSettled(
    misses.map(async (tier) => {
      const { counts, bucketStatusCounts } = await fetchCountsForTier(
        coord.lat,
        coord.lng,
        tier,
        { now: effectiveNow }
      );
      // Awaited, not fire-and-forget: an unawaited rejection would surface as an
      // unhandled rejection, and on serverless the process can exit first.
      // writeCounts never throws, so this cannot fail the request.
      await writeCounts(coord.lat, coord.lng, tier, counts, {
        now: effectiveNow,
        bucketStatusCounts,
      });
      return [tier, { counts, bucketStatusCounts }];
    })
  );

  const failure = settled.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;

  const fetched = Object.fromEntries(settled.map((outcome) => outcome.value));

  const counts = {
    ...cached,
    ...Object.fromEntries(Object.entries(fetched).map(([tier, v]) => [tier, v.counts])),
  };
  const bucketStatusCounts = {
    ...cachedStatusCounts,
    ...Object.fromEntries(
      Object.entries(fetched).map(([tier, v]) => [tier, v.bucketStatusCounts])
    ),
  };
  // Exactly the timestamp writeCounts just persisted for each fetched tier —
  // see the `effectiveNow` comment above for why this must be the same value,
  // not a separately-evaluated `new Date()`.
  for (const tier of Object.keys(fetched)) updatedAt[tier] = effectiveNow;

  return {
    coord,
    counts,
    bucketStatusCounts,
    updatedAt,
    cache: Object.fromEntries(
      tiers.map((tier) => [tier, misses.includes(tier) ? "miss" : "hit"])
    ),
  };
}

/** The most recent of several tier timestamps, or null if none are known. */
function latestTimestamp(updatedAt) {
  const values = Object.values(updatedAt)
    .filter(Boolean)
    .map((d) => new Date(d).getTime());
  return values.length ? new Date(Math.max(...values)) : null;
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
  return (await buildScoreReportInternal(lat, lng, options)).report;
}

/**
 * The shared implementation behind buildScoreReport — returns
 * `complaintsUpdatedAt` alongside the report for buildExplanation's benefit
 * (it needs that timestamp to stamp a freshly-generated summary, see below),
 * WITHOUT putting a real wall-clock value in the public report itself: an
 * uncached `/api/score` response must stay byte-identical across repeat
 * calls for the same coordinate, which a `meta.complaintsUpdatedAt` field
 * would have broken.
 */
async function buildScoreReportInternal(lat, lng, options) {
  if (isMockMode()) return { report: mockScoreReport(lat, lng), complaintsUpdatedAt: null };

  const [
    { coord, counts, cache, updatedAt, bucketStatusCounts },
    baseline,
    { amenities, amenityBaseline },
    cachedSummary,
  ] = await Promise.all([
    getCounts(lat, lng, options),
    loadBaseline(),
    // cacheOnly defaults to false here — this IS the one path allowed to
    // trigger a live, billed Places call for walkability on a cache miss.
    getAmenitiesForReport(lat, lng),
    // Issued alongside everything else, not after: same reasoning as the
    // baseline load above — a cheap, memoization-free Mongo read has no
    // reason to sit behind the counts/amenities calls it doesn't depend on.
    readAmenityExplanation(roundCoord(lat), roundCoord(lng), "overall"),
  ]);

  const complaintsUpdatedAt = latestTimestamp(updatedAt);

  const report = buildReport(
    counts,
    baseline,
    {
      // Coordinates are rounded for the cache key, so the circle we actually
      // queried is not exactly the one asked for. Say so rather than implying
      // more precision than we have.
      coord,
      cache,
    },
    amenities,
    amenityBaseline,
    bucketStatusCounts
  );

  // Every section's "Why this score?" is attached here, and it is ALWAYS the
  // deterministic template — none of these six ever calls the AI. The one AI
  // text in the whole report is `summary` below, which is why it is the only
  // one worth a cache-freshness check at all.
  for (const [tier, key] of Object.entries(REPORT_KEYS)) {
    report[key] = { ...report[key], ...explainFromTemplate(tier, report[key]) };
  }

  // Cache-first-else-template, but spanning ALL sections at once and gated on
  // freshness — see resolveCachedOverallSummary.
  report.summary = resolveCachedOverallSummary(report, cachedSummary, complaintsUpdatedAt);

  return { report, complaintsUpdatedAt };
}

/**
 * The same payload as buildScoreReport, but ONLY if it is already cached.
 *
 * Returns null when either tier is missing, rather than a half-scored report:
 * the overall verdict is the worse of the two bands, so a report holding one
 * band is not a weaker version of the answer, it is a different answer. Callers
 * show nothing for a null.
 *
 * No Socrata and no AI — cached counts plus the memoized baseline, so this is
 * Mongo latency plus arithmetic (measured 2-5ms warm). That is what makes it
 * safe on the homepage's render path.
 */
export async function buildCachedScoreReport(lat, lng, options = {}) {
  if (isMockMode()) return mockScoreReport(lat, lng);

  const [
    { coord, counts, cache, updatedAt, bucketStatusCounts },
    baseline,
    { amenities, amenityBaseline },
    cachedSummary,
  ] = await Promise.all([
    getCounts(lat, lng, { ...options, cacheOnly: true }),
    loadBaseline(),
    // The three static-dataset tiers have no Socrata dependency at all —
    // no "cacheOnly" concept applies to them, already as cheap as the
    // complaint path's cache read. Walkability is different: it is a live,
    // billed Places call on a cache miss, which this render path must
    // never trigger — cacheOnly: true here means a cold coordinate simply
    // omits walkabilityAccess rather than paying for it on the homepage.
    getAmenitiesForReport(lat, lng, { cacheOnly: true }),
    // A plain Mongo read, same as the counts/amenity cache reads above —
    // never a live AI call, so it belongs on this cache-only render path.
    readAmenityExplanation(roundCoord(lat), roundCoord(lng), "overall"),
  ]);

  if (ALL_TIERS.some((tier) => counts[tier] === null)) return null;

  const report = buildReport(
    counts,
    baseline,
    { coord, cache },
    amenities,
    amenityBaseline,
    bucketStatusCounts
  );

  for (const [tier, key] of Object.entries(REPORT_KEYS)) {
    report[key] = { ...report[key], ...explainFromTemplate(tier, report[key]) };
  }

  report.summary = resolveCachedOverallSummary(report, cachedSummary, latestTimestamp(updatedAt));

  return report;
}

/** Which response key each radius tier lands under. */
const REPORT_KEYS = {
  building: "buildingHealth",
  block: "blockQuality",
};

/**
 * A cached AI summary wins, otherwise the deterministic template. Two things
 * have to hold for the cache to count, not just one:
 *
 * 1. Only "ai" is accepted at all — a cached *template* string is free to
 *    rebuild, and storing it would make the frontend think the AI had
 *    already run and skip its GET /api/explanation?tier=overall call.
 * 2. It must be FRESH: `cached.basedOn` (the complaint-counts timestamp the
 *    summary was generated from, stamped by buildExplanation below) must
 *    match `complaintsUpdatedAt` (the current one, computed from the SAME
 *    getCounts call the report itself was just built from — see
 *    buildScoreReportInternal). Those two drift apart precisely when the
 *    counts doc has been refreshed since the summary was written — the
 *    summary and the counts each sit on their OWN 24h TTL, ticking from
 *    independent last-write times, so nothing else forces them to expire
 *    together. Without this check a stale summary could describe counts up
 *    to 24h out of date while every badge on the page already reflects the
 *    refreshed ones. A missing `basedOn` (a summary written before this
 *    check existed) counts as stale too, rather than being grandfathered in
 *    as fresh.
 *
 * `complaintsUpdatedAt` is deliberately NOT part of the public report (it
 * would make an uncached /api/score response vary between two otherwise-
 * identical calls) — it only ever exists as a local value threaded between
 * the functions in this file that need it.
 */
function resolveCachedOverallSummary(report, cached, complaintsUpdatedAt) {
  const fresh =
    cached?.basedOn != null &&
    complaintsUpdatedAt != null &&
    new Date(cached.basedOn).getTime() === new Date(complaintsUpdatedAt).getTime();

  if (
    fresh &&
    cached.explanationSource === EXPLANATION_SOURCES.ai &&
    typeof cached.explanation === "string" &&
    cached.explanation !== ""
  ) {
    return {
      explanation: cached.explanation,
      explanationSource: EXPLANATION_SOURCES.ai,
    };
  }
  return explainOverallFromTemplate(report);
}

/**
 * The SLOW path behind GET /api/explanation?tier=overall: generate the
 * whole-report summary with the active AI adapter, store it, return it. This
 * is the ONLY explanation in the app that ever calls the AI adapter — every
 * per-section "Why this score?" is the deterministic template, attached
 * directly in buildScoreReport/buildCachedScoreReport above.
 *
 * Reuses buildScoreReportInternal rather than re-fetching counts/amenities
 * itself — that already resolves this tier's own cached (and freshness-
 * checked) summary via resolveCachedOverallSummary above, so
 * `report.summary.explanationSource` already says whether a fresh AI summary
 * exists without a second cache read here. Needs the internal variant, not
 * the public buildScoreReport, because it also needs `complaintsUpdatedAt`
 * to stamp on a freshly-generated summary — see resolveCachedOverallSummary's
 * doc comment for why that value is not part of the public report.
 */
export async function buildExplanation(lat, lng) {
  const { report, complaintsUpdatedAt } = await buildScoreReportInternal(lat, lng, {});

  if (report.summary.explanationSource === EXPLANATION_SOURCES.ai) {
    return {
      explanation: report.summary.explanation,
      explanationSource: EXPLANATION_SOURCES.ai,
      cached: true,
    };
  }

  const { explanation, explanationSource } = await explainOverallWithAI(report);

  if (explanationSource === EXPLANATION_SOURCES.ai) {
    await writeAmenityExplanation(
      roundCoord(lat),
      roundCoord(lng),
      "overall",
      explanation,
      explanationSource,
      // Stamped so a LATER counts refresh can be detected as making this
      // summary stale — see resolveCachedOverallSummary above.
      { basedOn: complaintsUpdatedAt }
    );
  }

  return { explanation, explanationSource, cached: false };
}

/**
 * Individual complaint points for the frontend heatmap.
 *
 * NOT cached: the cache stores bucket counts, not rows, and caching thousands
 * of points per coordinate is what CLAUDE.md's "no bulk ingest" rule exists to
 * prevent. The heatmap is a secondary view; the score is what must be fast.
 */
export async function fetchComplaintPoints(lat, lng, radiusMeters, options = {}) {
  // Rounded like every other read on this page. The score's counts, the grouped
  // browser, and the drill-in all describe the rounded circle; querying the raw
  // one here made this list the odd one out, so a complaint could appear under
  // "Recent complaints" that the browser beside it did not have.
  const coord = { lat: roundCoord(lat), lng: roundCoord(lng) };

  if (isMockMode()) {
    const points = mockComplaints(coord.lat, coord.lng, radiusMeters).map(withStatusBucket);
    return { points, truncated: false, limit: points.length };
  }

  const limit = options.limit ?? COMPLAINTS_DEFAULT_LIMIT;
  const points = await fetchComplaints(coord.lat, coord.lng, radiusMeters, { ...options, limit });

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

  // Rounded before querying, exactly as getCounts() does and for the same
  // reason: readComplaintGroups keys on the rounded coordinate, so filling the
  // entry from the raw one would let a hit and a miss describe measurably
  // different circles — and the drill-in, which rounds identically, would then
  // disagree with the counts it was opened from.
  const coord = { lat: roundCoord(lat), lng: roundCoord(lng) };

  if (isMockMode()) {
    groups = groupMockComplaints(coord.lat, coord.lng, radiusMeters);
  } else {
    // The cache key has no radius dimension, so an ad-hoc radius must neither
    // read from nor write to it — it would collide with the tier's own entry
    // and describe a different circle.
    const cacheable = Boolean(tier) && radiusMeters === RADIUS_TIERS[tier].radiusMeters;

    if (cacheable) {
      const hit = await readComplaintGroups(coord.lat, coord.lng, tier);
      if (hit) {
        ({ groups, truncated } = hit);
        cached = true;
      }
    }

    if (!groups) {
      // Always filled at the CACHE limit, never the caller's page size —
      // otherwise a limit=25 request would store a 25-row entry that every
      // later page has to discard.
      groups = await fetchComplaintGroups(coord.lat, coord.lng, radiusMeters, {
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
        await writeComplaintGroups(coord.lat, coord.lng, tier, groups, truncated).catch(() => {});
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
  // Rounded for the same reason as the group list above, and it must be rounded
  // the SAME way: a drill-in describing a different circle from the row that
  // opened it is exactly the disagreement being fixed here.
  const coord = { lat: roundCoord(lat), lng: roundCoord(lng) };

  if (isMockMode()) {
    const all = mockComplaints(coord.lat, coord.lng, radiusMeters)
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
  //
  // `status` goes INTO the query rather than filtering the result. It used to
  // filter the page after slicing, which made both the page and `hasMore` wrong:
  // the rows were drawn from every status, so a day with 100 complaints of which
  // 3 were open rendered an empty list under a header that said 3. Expanding the
  // bucket into raw statuses happens in socrata.js off rawStatusesForBucket(),
  // so the enum still lives only in constants.js.
  const points = await fetchComplaintsForGroup(coord.lat, coord.lng, radiusMeters, {
    type,
    day,
    status,
    offset,
    limit: limit + 1,
  });

  const hasMore = points.length > limit;

  return {
    points: hasMore ? points.slice(0, limit) : points,
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

  // Rounded, like every other read: trendCacheKey rounds, so querying the raw
  // coordinate would let a hit and a miss describe different circles — and this
  // series is what the report totals ("Show all N") are counted from.
  const coord = { lat: roundCoord(lat), lng: roundCoord(lng) };

  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(reference.getFullYear(), reference.getMonth() - i, 1);
    buckets.push({
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      count: 0,
    });
  }

  if (isMockMode()) {
    return fill(
      buckets,
      mockMonthlyTrend(coord.lat, coord.lng, radiusMeters, { tier, months, now: reference })
    );
  }

  // Cache the finished series, not the raw rows: it is small (≤24 numbers), and
  // the block-tier query is the slowest call in the app — 13s cold on a dense
  // block, which is inside the Socrata retry budget but outside a serverless
  // function's. The cached path is the one that has to hold up in production.
  const cached = await readTrend(coord.lat, coord.lng, tier, months);
  if (cached) return cached;

  const points = await fetchMonthlyTrend(coord.lat, coord.lng, radiusMeters, {
    tier,
    months,
    now: reference,
  });
  const series = fill(buckets, points);

  // Not awaited into the response path — a slow cache write must not delay the
  // chart, and a failed one costs a repeat query, not a request.
  writeTrend(coord.lat, coord.lng, tier, months, series).catch(() => {});

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
