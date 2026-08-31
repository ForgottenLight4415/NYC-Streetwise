import { GOOGLE_ROUTES_MATRIX_URL, GOOGLE_ROUTES_TIMEOUT_MS } from "../config/constants.js";

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
 * response all degrade to "no correction for anyone" — the caller (
 * amenityService) already has the straight-line distance in hand and falls
 * back to it per destination. A billed, rate-limited third-party call must
 * never be the reason /api/score fails.
 *
 * @param {{lat: number, lng: number}} origin
 * @param {{lat: number, lng: number}[]} destinations
 * @returns {Promise<(number|null)[]>} one entry per destination, in the same
 *   order — real walking metres, or null where Google found no route or the
 *   call failed outright.
 */
export async function computeWalkingDistances(origin, destinations) {
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
    console.warn("[googleRoutes] computeRouteMatrix failed, falling back to straight-line:", err.message);
    return missing;
  }
}
