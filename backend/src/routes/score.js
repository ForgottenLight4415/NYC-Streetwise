import { Router } from "express";
import { RATE_LIMIT_UPSTREAM } from "../config/constants.js";
import { validateCoords } from "../lib/validate.js";
import { rateLimit } from "../lib/rateLimit.js";
import { buildScoreReport } from "../services/scoreService.js";

export const scoreRouter = Router();

/**
 * POST /api/score  body: { lat, lng }
 *
 * Response shape is FROZEN (see CLAUDE.md); M5 swapped the mock for real
 * Socrata + baseline data without changing any existing field. The additive
 * `confidence` / `bucketConfidence` / `bucketScores` / `meta` fields are safe
 * for a frontend to ignore.
 */
// Rate limited because a miss is two live Socrata queries and a Mongo write,
// and the caller picks the coordinate: the NYC bounding box holds ~33 million
// distinct cache keys at this precision, so an unthrottled loop over it burns
// the Socrata token and fills the free-tier cluster without sending a single
// invalid request.
scoreRouter.post(
  "/api/score",
  rateLimit({ ...RATE_LIMIT_UPSTREAM, name: "score" }),
  async (req, res, next) => {
  try {
    const { lat, lng } = validateCoords(req.body ?? {});
    res.json(await buildScoreReport(lat, lng));
  } catch (err) {
    next(err);
  }
  }
);
