import { GOOGLE_PLACES_NEARBY_URL, GOOGLE_PLACES_TIMEOUT_MS } from "../config/constants.js";

/**
 * Nearby places of any of `includedTypes`, ranked by distance, via Google's
 * Places API (New) `searchNearby`.
 *
 * ONE HTTP call covers every bucket at once — `includedTypes` is passed as a
 * single combined list, and the caller (getWalkabilityMetrics) sorts the
 * results back into buckets by inspecting each place's own `types`. That is
 * what keeps this feature's cost bounded to one call per (new) coordinate,
 * not one per bucket.
 *
 * The field mask below is deliberately narrow: Places API (New) bills by
 * which fields a request asks for, and every extra field named here (photos,
 * ratings, opening hours, ...) moves the call into a more expensive SKU for
 * data this feature never uses.
 *
 * NEVER THROWS. A missing key, a network failure, a timeout, or a malformed
 * response all degrade to "nothing found" — the caller already treats an
 * empty result as a genuine (if unlikely) "nothing nearby" answer, since a
 * billed, rate-limited third-party call must never be the reason /api/score
 * fails.
 *
 * @param {{lat: number, lng: number}} origin
 * @param {number} radiusMeters
 * @param {string[]} includedTypes
 * @returns {Promise<{lat: number, lng: number, types: string[], name: string|null}[]>}
 */
export async function searchNearbyPlaces(origin, radiusMeters, includedTypes) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY; // read at call time, not import time
  if (!apiKey) return [];

  const body = {
    includedTypes,
    maxResultCount: 20,
    rankPreference: "DISTANCE",
    locationRestriction: {
      circle: {
        center: { latitude: origin.lat, longitude: origin.lng },
        radius: radiusMeters,
      },
    },
  };

  try {
    const res = await fetch(GOOGLE_PLACES_NEARBY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.location,places.types,places.displayName",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GOOGLE_PLACES_TIMEOUT_MS),
    });
    if (!res.ok) return [];

    const data = await res.json();
    if (!Array.isArray(data.places)) return [];

    // Normalised to the app's own {lat, lng, types, name} shape immediately,
    // rather than caching Google's raw response — the cache document should
    // not be coupled to Places API's exact response schema.
    return data.places
      .filter((p) => p.location)
      .map((p) => ({
        lat: p.location.latitude,
        lng: p.location.longitude,
        types: Array.isArray(p.types) ? p.types : [],
        name: p.displayName?.text ?? null,
      }));
  } catch {
    return [];
  }
}
