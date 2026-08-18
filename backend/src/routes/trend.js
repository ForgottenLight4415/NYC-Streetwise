import { Router } from "express";
import { validateCoords, validateTier, validateMonths } from "../lib/validate.js";
import { fetchTrend } from "../services/scoreService.js";
import {
  RADIUS_TIERS,
  TREND_WINDOW_OPTIONS,
  TREND_DEFAULT_MONTHS,
} from "../config/constants.js";

export const trendRouter = Router();

/**
 * GET /api/trend?lat=&lng=&tier=building|block&months=
 *
 * Complaints per calendar month for one tier, oldest first, zero-filled so the
 * series has no gaps.
 *
 * Exists because /api/complaints cannot answer this. That endpoint returns
 * individual records capped at a row limit, and on a dense block the most
 * recent 200 records span a couple of weeks — bucketing them by month draws a
 * cliff, not a history. Here Socrata does the bucketing ($group on
 * date_trunc_ym), so the response is one row per month regardless of whether
 * the location has 12 complaints or 12,000, and there is nothing to truncate.
 *
 * `radiusMeters` is echoed back because the caller labels the chart with it and
 * should not have to keep its own copy of the tier radii.
 */
trendRouter.get("/api/trend", async (req, res, next) => {
  try {
    const { lat, lng } = validateCoords(req.query);
    const tier = validateTier(req.query.tier);
    const months = validateMonths(req.query.months, {
      options: TREND_WINDOW_OPTIONS,
      fallback: TREND_DEFAULT_MONTHS,
    });

    const radiusMeters = RADIUS_TIERS[tier].radiusMeters;
    const points = await fetchTrend(lat, lng, radiusMeters, { tier, months });

    res.json({
      tier,
      months,
      radiusMeters,
      points,
      total: points.reduce((sum, p) => sum + p.count, 0),
    });
  } catch (err) {
    next(err);
  }
});
