import { Router } from "express";
import { bearerAuthStatus } from "../lib/bearerAuth.js";
import { NON_DISCRETE_AMENITY_BUCKETS, RATE_LIMIT_READ } from "../config/constants.js";
import { rateLimit } from "../lib/rateLimit.js";
import {
  validateAmenityBucket,
  validateAmenityTier,
  validateCoords,
} from "../lib/validate.js";
import { fetchBikeShareBucket } from "../providers/amenities/bikeShare.js";
import { loadRawAmenityDataset, saveAmenityDataset } from "../providers/amenities/index.js";
import {
  getNearbyAmenityInstances,
  getNearbyWalkabilityInstances,
} from "../services/amenityService.js";

export const amenitiesRouter = Router();

/**
 * GET /api/refresh-amenities   header: Authorization: Bearer $CRON_SECRET
 *
 * THE ONE LIVE-REFRESHED AMENITY BUCKET. Citi Bike docks genuinely churn
 * month to month; subway entrances, park boundaries, and DOT bike-lane
 * geometry change on a scale of years. Re-downloading all six buckets
 * monthly would buy nothing for five of them and add a monthly opportunity
 * for an upstream hiccup to overwrite good committed data with a truncated
 * file. See CLAUDE.md's "Amenity Scores" section for the full reasoning —
 * this is a signal decision, not a Vercel timeout workaround (the function
 * cap is a confirmed 300s via Fluid Compute, comfortably enough for all six).
 *
 * Same auth pattern as GET /api/warm (bearerAuthStatus + CRON_SECRET) —
 * Vercel sends the bearer header on scheduled invocations automatically once
 * CRON_SECRET is set on the project, so the cron (vercel.json) needs no code
 * of its own.
 *
 * Fetches fresh bikeShare, keeps the OTHER two "bike" dataset buckets
 * (bikeLane, protectedLane) exactly as currently served — loadRawAmenityDataset()
 * reads whichever source (Mongo or committed file) is currently winning, so
 * a bikeLane geometry rebuilt via `npm run build:amenities` and committed
 * since the last refresh is preserved, not silently reverted to whatever was
 * in Mongo. saveAmenityDataset() then runs the SAME >30%-drop sanity guard
 * scripts/buildAmenities.js's CLI does before writing.
 */
amenitiesRouter.get("/api/refresh-amenities", async (req, res, next) => {
  const auth = bearerAuthStatus(req, process.env.CRON_SECRET);

  if (auth === "not_configured") {
    return res.status(503).json({
      error: "refresh_amenities_not_configured",
      details: "CRON_SECRET is not set on this deployment, so refreshing is disabled.",
    });
  }
  if (auth !== "ok") {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const [bikeShare, current] = await Promise.all([
      fetchBikeShareBucket(),
      loadRawAmenityDataset("bike"),
    ]);

    if (!current) {
      return res.status(503).json({
        error: "no_existing_bike_dataset",
        details: "No current bike dataset (Mongo or committed file) to merge the refresh into.",
      });
    }

    const doc = { bikeShare, bikeLane: current.bikeLane, protectedLane: current.protectedLane };
    const saved = await saveAmenityDataset("bike", doc);

    res.json({
      saved,
      bikeShareStations: bikeShare.n,
      refreshedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/amenities/nearby?lat=&lng=&tier=&bucket=
 *
 * **CONTRACT CHANGE (post-freeze): new endpoint. Flag to Person 2.** See
 * CLAUDE.md's "Amenity Scores" section for the full write-up.
 *
 * Every real instance of one bucket within its tier's radius — the full list
 * behind an amenity row's `>` affordance, not just the single nearest one
 * getAmenityMetrics()/AmenityMetric report for scoring. For transit/parks/
 * bike this is a pure in-memory grid lookup (spatialIndex.allWithin()) over
 * data already loaded by providers/amenities/index.js at process start — no
 * Socrata, no Mongo, no external call, and no new caching layer needed
 * beyond that. Walkability is the one exception: it has no preloaded index,
 * so its buckets are served cache-only from whatever Places result
 * /api/score already wrote for this coordinate (see
 * getNearbyWalkabilityInstances) — still no LIVE external call from this
 * route, just a Mongo read.
 *
 * bikeLane/protectedLane are refused outright (400 bucket_not_applicable):
 * their "points" are a bike-route LINE resampled every
 * AMENITY_LANE_SPACING_METERS, so "every instance within radius" would
 * return dozens of meaningless ~40m-spaced points along the same lane, not a
 * real list of distinct places. See NON_DISCRETE_AMENITY_BUCKETS.
 *
 * Rate-limited under RATE_LIMIT_READ, same tier as GET /api/showcase — this
 * never reaches Socrata or (bar the walkability cache-read) Mongo, so it
 * belongs with the other cheap reads rather than RATE_LIMIT_UPSTREAM.
 */
amenitiesRouter.get(
  "/api/amenities/nearby",
  rateLimit({ ...RATE_LIMIT_READ, name: "amenities-nearby" }),
  async (req, res, next) => {
    try {
      const { lat, lng } = validateCoords(req.query);
      const tier = validateAmenityTier(req.query.tier);
      const bucket = validateAmenityBucket(req.query.bucket, tier);

      if (NON_DISCRETE_AMENITY_BUCKETS.includes(bucket)) {
        return res.status(400).json({
          error: "bucket_not_applicable",
          details: `${bucket} is a resampled bike-route line, not a set of discrete instances — "nearby" has no meaning for it.`,
        });
      }

      const result =
        tier === "walkability"
          ? await getNearbyWalkabilityInstances(bucket, lat, lng)
          : await getNearbyAmenityInstances(tier, bucket, lat, lng);

      if (!result) {
        return res.status(503).json({ error: "amenity_dataset_unavailable" });
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);
