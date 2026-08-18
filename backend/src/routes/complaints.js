import { Router } from "express";
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
complaintsRouter.get("/api/complaints", async (req, res, next) => {
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
});

/**
 * GET /api/complaints/group?lat=&lng=&tier=&type=&day=&status=&offset=&limit=
 *
 * The individual complaints behind one (day, type) row of the browser above.
 * Paginated, not merely capped: the largest group measured is 4,978 rows.
 *
 * `radius` comes from the tier rather than the caller, so a drill-in always
 * describes the same circle as the group it came from.
 */
complaintsRouter.get("/api/complaints/group", async (req, res, next) => {
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
    res.json(points);
  } catch (err) {
    next(err);
  }
});
