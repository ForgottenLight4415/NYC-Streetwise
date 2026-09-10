import { GOOGLE_ROUTES_MATRIX_URL, GOOGLE_ROUTES_TIMEOUT_MS } from "../config/constants.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real walking distance from one origin to a batch of destinations, via
 * Google's Routes API (`computeRouteMatrix`, travelMode WALK).
 *
 * ONE HTTP call covers the whole batch — every candidate across every
 * amenity bucket goes in a single request. That batching is what keeps this
 * feature's cost and latency bounded to one extra call per score, not one
 * per candidate.
 *
 * NEVER THROWS. A missing key, a network failure, a timeout, or a malformed
 * response — even after retries are exhausted — all degrade to "no
 * correction for anyone" — the caller (amenityService) already has the
 * straight-line distance in hand and falls back to it per destination. A
 * billed, rate-limited third-party call must never be the reason /api/score
 * fails.
 *
 * @param {{lat: number, lng: number}} origin
 * @param {{lat: number, lng: number}[]} destinations
 * @param {{retries?: number}} [options] Defaults to 0 — the request path
 *   (amenityService's getAmenityMetrics, called on every /api/score) must
 *   fail fast within GOOGLE_ROUTES_TIMEOUT_MS, not add retry latency to a
 *   live user request. scripts/buildAmenityBaseline.js overrides this: it
 *   fires ~150 sequential live calls with no other rate limiting, so a
 *   transient 429 there is worth a bounded, jittered retry (same pattern as
 *   providers/socrata.js's query()) rather than silently degrading that
 *   sample point to straight-line.
 * @returns {Promise<(number|null)[]>} one entry per destination, in the same
 *   order — real walking metres, or null where Google found no route or the
 *   call failed outright.
 */
export async function computeWalkingDistances(origin, destinations, { retries = 0 } = {}) {
  const missing = destinations.map(() => null);
  if (destinations.length === 0) return missing;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY; // read at call time, not import time
  if (!apiKey) return missing;

  const body = {
    origins: [{ waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } }],
    destinations: destinations.map((d) => ({
      waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
    })),
    travelMode: "WALK",
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 300ms, 900ms — jittered so a batch script's retries don't line up
      // with each other or with the next sequential point's fresh attempt.
      await sleep(300 * 3 ** (attempt - 1) * (0.5 + Math.random()));
    }

    try {
      const res = await fetch(GOOGLE_ROUTES_MATRIX_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          // Required by computeRouteMatrix, and worth keeping narrow: every
          // extra field named here is extra data Google bills and sends back.
          "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,condition",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GOOGLE_ROUTES_TIMEOUT_MS),
      });

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) {
          console.warn(`[googleRoutes] computeRouteMatrix ${res.status}, retrying (attempt ${attempt + 1}/${retries})`);
          continue;
        }
        console.warn(`[googleRoutes] computeRouteMatrix ${res.status}, falling back to straight-line`);
        return missing;
      }

      const rows = await res.json();
      if (!Array.isArray(rows)) return missing;

      const result = [...missing];
      for (const row of rows) {
        const i = row?.destinationIndex;
        if (
          Number.isInteger(i) &&
          i >= 0 &&
          i < result.length &&
          row.condition === "ROUTE_EXISTS" &&
          Number.isFinite(row.distanceMeters)
        ) {
          result[i] = row.distanceMeters;
        }
      }
      return result;
    } catch (err) {
      if (attempt < retries) {
        console.warn(`[googleRoutes] computeRouteMatrix failed, retrying (attempt ${attempt + 1}/${retries}):`, err.message);
        continue;
      }
      console.warn("[googleRoutes] computeRouteMatrix failed, falling back to straight-line:", err.message);
      return missing;
    }
  }

  return missing;
}
