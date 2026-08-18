import { Router } from "express";
import {
  RATE_LIMIT_FILL,
  RATE_LIMIT_UPSTREAM,
} from "../config/constants.js";
import { rateLimit } from "../lib/rateLimit.js";
import {
  validateCoords,
  validateRadius,
  validateLimit,
  validateOffset,
  validateOptionalTier,
  validateTier,
  validateBucket,
  validateStatus,
  validateDay,
  validateComplaintType,
  validateMonths,
} from "../lib/validate.js";
import {
  fetchComplaintPoints,
  fetchComplaintGroupList,
  fetchComplaintGroupDetail,
} from "../services/scoreService.js";
import {
  RADIUS_TIERS,
  COMPLAINTS_DEFAULT_LIMIT,
  COMPLAINTS_MAX_LIMIT,
  COMPLAINTS_MAX_OFFSET,
  TREND_WINDOW_OPTIONS,
  WINDOW_MONTHS,
} from "../config/constants.js";

export const complaintsRouter = Router();

/**
 * GET /api/complaints?lat=&lng=&radius=&limit=&tier=&months=&bucket=&status=&offset=&complete=
 *
 * The body stays a bare JSON array — that is the frozen contract. Everything
 * about the page (totals, offset, truncation) is reported in HEADERS instead,
 * because a dense block returns only its most recent months at the row cap and
 * a frontend that counted from this array would disagree with the score.
 * Wrapping the array in an object would have been cleaner and would have broken
 * every existing caller, so: headers.
 *
 *   X-Complaints-Truncated: true|false
 *   X-Complaints-Limit:     the row cap actually applied
 *   X-Complaints-Total:     rows (or groups) matching the filters, before paging
 *   X-Complaints-Offset:    the offset actually applied
 *   X-Complaints-Has-More:  true|false
 *   X-Complaints-Cached:    true when served from Mongo
 *
 * Two modes:
 *
 * - default — raw complaint rows, newest first, exactly as before. Used by the
 *   report page, which needs only its first screenful. Never triggers a cache
 *   fill, because the fill was measured at 2.3-74.3s and must not sit on the
 *   path to a page load.
 * - complete=1 — one row per (day, complaint_type) with a status breakdown,
 *   served from the grouped cache. Used by the complaints browser, where an
 *   explicit click justifies paying for the fill once per address per day.
 */
// Two limiters, because this endpoint has two wildly different costs behind one
// path. The default mode is a bounded row query; `complete=1` triggers the
// grouped fill, measured 2.3-74.3s per cold address and the single most
// expensive thing an anonymous caller can ask for. `when` applies the strict one
// only to that mode, so the cheap read is not punished for sharing a route.
complaintsRouter.get(
  "/api/complaints",
  rateLimit({
    ...RATE_LIMIT_FILL,
    name: "complaints-fill",
    when: (req) => req.query.complete === "1" || req.query.complete === "true",
  }),
  rateLimit({ ...RATE_LIMIT_UPSTREAM, name: "complaints" }),
  async (req, res, next) => {
  try {
    const { lat, lng } = validateCoords(req.query);
    const radius = validateRadius(req.query.radius, {
      fallback: RADIUS_TIERS.block.radiusMeters,
    });
    // Optional, and omitted means "every type in both tiers" as before, so
    // existing callers are unaffected.
    const tier = validateOptionalTier(req.query.tier);
    const complete = req.query.complete === "1" || req.query.complete === "true";

    if (!complete) {
      const limit = validateLimit(req.query.limit, {
        fallback: COMPLAINTS_DEFAULT_LIMIT,
        max: COMPLAINTS_MAX_LIMIT,
      });
      const { points, truncated } = await fetchComplaintPoints(lat, lng, radius, {
        limit,
        tier,
      });

      res.set("X-Complaints-Truncated", String(truncated));
      res.set("X-Complaints-Limit", String(limit));
      res.set("X-Complaints-Cached", "false");
      return res.json(points);
    }

    const months = validateMonths(req.query.months, {
      options: TREND_WINDOW_OPTIONS,
      fallback: WINDOW_MONTHS,
    });
    const bucket = validateBucket(req.query.bucket, tier);
    const status = validateStatus(req.query.status);
    const offset = validateOffset(req.query.offset, { max: COMPLAINTS_MAX_OFFSET });
    const limit = validateLimit(req.query.limit, {
      fallback: 25,
      max: COMPLAINTS_MAX_LIMIT,
    });

    const result = await fetchComplaintGroupList(lat, lng, radius, {
      tier,
      months,
      bucket,
      status,
      offset,
      limit,
    });

    res.set("X-Complaints-Truncated", String(result.truncated));
    res.set("X-Complaints-Limit", String(limit));
    res.set("X-Complaints-Total", String(result.total));
    res.set("X-Complaints-Offset", String(offset));
    res.set("X-Complaints-Has-More", String(result.hasMore));
    res.set("X-Complaints-Cached", String(result.cached));
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
  }
);

/**
 * GET /api/complaints/group?lat=&lng=&tier=&type=&day=&status=&offset=&limit=
 *
 * The individual complaints behind one (day, type) row of the browser above.
 * Paginated, not merely capped: the largest group measured is 4,978 rows.
 *
 * `radius` comes from the tier rather than the caller, so a drill-in always
 * describes the same circle as the group it came from.
 *
 * UPSTREAM INCONSISTENCY, and it is CONFINED TO THE NEWEST DAYS. Measured at
 * 123 Ludlow St, block tier, on 2026-08-18:
 *
 *   - Row queries over the last 11 days x 2 complaint types, 5 identical runs
 *     each: 21 of 22 combinations returned the same count every time AND
 *     matched the grouped aggregate exactly. The one exception was 2026-08-16
 *     "Noise - Street/Sidewalk" — two days old — which alternated 4 and 8.
 *   - The grouped query itself was stable: 4 full runs, 3,123 rows over 729
 *     days, byte-identical per-day totals. Nothing older than a few days moved.
 *
 * The mechanism is revision, not random flakiness. That day's records were
 * still being rewritten upstream (:updated_at within the previous 24h), and
 * mid-revision the replicas disagree: one had 4 rows with statuses "In
 * Progress", the other had those same records advanced to "Closed" plus 4
 * newly-ingested ones. Once a day stops being revised, every replica agrees on
 * it and it stays agreed. 311 also publishes with a lag, so the last day or two
 * legitimately read as empty before they fill in.
 *
 * So: no snapshot can be pinned (public SODA exposes no such parameter), but
 * nothing needs pinning for the bulk of the window. What this endpoint does is
 * avoid compounding the narrow case — X-Complaints-Total is emitted from the
 * rows this response actually contains, so the client shows a count matching
 * its own list rather than one contradicting it. The grouped browser's per-day
 * count comes from a 24h cache filled from one snapshot, so for a day that is
 * still being revised the two can legitimately differ.
 */
// Live and uncached by design — 5.6s measured for a 17-row day.
complaintsRouter.get(
  "/api/complaints/group",
  rateLimit({ ...RATE_LIMIT_UPSTREAM, name: "complaints-group" }),
  async (req, res, next) => {
  try {
    const { lat, lng } = validateCoords(req.query);
    const tier = validateTier(req.query.tier);
    const type = validateComplaintType(req.query.type);
    const day = validateDay(req.query.day);
    const status = validateStatus(req.query.status);
    const offset = validateOffset(req.query.offset, { max: COMPLAINTS_MAX_OFFSET });
    const limit = validateLimit(req.query.limit, { fallback: 50, max: COMPLAINTS_MAX_LIMIT });

    const { points, hasMore } = await fetchComplaintGroupDetail(
      lat,
      lng,
      RADIUS_TIERS[tier].radiusMeters,
      { type, day, status, offset, limit }
    );

    res.set("X-Complaints-Limit", String(limit));
    res.set("X-Complaints-Offset", String(offset));
    res.set("X-Complaints-Has-More", String(hasMore));
    // Only when the last page is in hand is the total actually known, and then
    // it is exact. Sent because the caller's other number for this — the group
    // row's cached count — comes from a DIFFERENT Socrata snapshot and can
    // disagree with what this query just returned; see the note on the endpoint.
    if (!hasMore) res.set("X-Complaints-Total", String(offset + points.length));
    res.json(points);
  } catch (err) {
    next(err);
  }
  }
);
