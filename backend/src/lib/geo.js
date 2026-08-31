// Pure geo math for the amenity distiller and spatial index. No dependencies,
// no network, no Mongo — everything here is a function of its arguments.

const EARTH_RADIUS_METERS = 6371000;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle metres between two coordinates (haversine formula). */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

const METERS_PER_FOOT = 0.3048;
const METERS_PER_MILE = 1609.344;

/** Below this, format as feet; at or above it, as miles. ~0.1 mile. */
const MILE_THRESHOLD_METERS = METERS_PER_MILE / 10;

/**
 * "70 ft" under ~0.1 mile, "0.3 mi" at or above it — the imperial-unit
 * counterpart to the frontend's `formatDistance` (lib/amenities.ts), for the
 * few deterministic explanation sentences and AI-prompt inputs that embed a
 * raw distance in their own generated text (templateOverallSummary.js,
 * templateAmenityExplanation.js, providers/ai/prompt.js, explain.js's
 * radiusLabelFor). Every internal computation still works in metres — the
 * haversine functions above, the spatial index, the cached scores — this is
 * presentation-only, applied at the one point each of those strings is
 * assembled, same rule the frontend follows.
 */
export function formatDistanceImperial(meters) {
  if (meters < MILE_THRESHOLD_METERS) {
    const feet = Math.round(meters / METERS_PER_FOOT / 10) * 10;
    return `${feet} ft`;
  }
  const miles = meters / METERS_PER_MILE;
  return `${miles.toFixed(1)} mi`;
}

/**
 * Resamples a LineString into points spaced `spacingMeters` apart along its
 * length, always including the first and last vertex. Input/output
 * coordinates are [lng, lat] pairs — GeoJSON order, matching `the_geom` as
 * Socrata returns it.
 *
 * This is what collapses the bike-lane geometry problem into the same
 * nearest-point problem as every other dataset. Distance-to-nearest-densified-
 * point overestimates true distance-to-segment by at most spacingMeters/2 —
 * 12.5m at 25m spacing, well inside the resolution anyone acts on. The
 * alternative (point-to-segment projection over every vertex pair) is more
 * code, more per-request work, and buys precision the score cannot use.
 */
export function densifyLine(coordinates, spacingMeters) {
  if (coordinates.length === 0) return [];
  if (coordinates.length === 1) return [coordinates[0]];

  const out = [coordinates[0]];
  let carry = 0; // distance past the last emitted point, within the current segment

  for (let i = 1; i < coordinates.length; i++) {
    const [lng0, lat0] = coordinates[i - 1];
    const [lng1, lat1] = coordinates[i];
    const segmentLength = haversineMeters(lat0, lng0, lat1, lng1);
    if (segmentLength === 0) continue;

    let distanceAlong = spacingMeters - carry;
    while (distanceAlong < segmentLength) {
      const t = distanceAlong / segmentLength;
      out.push([lng0 + (lng1 - lng0) * t, lat0 + (lat1 - lat0) * t]);
      distanceAlong += spacingMeters;
    }
    carry = distanceAlong - segmentLength;
  }

  const last = coordinates[coordinates.length - 1];
  const [outLng, outLat] = out[out.length - 1];
  if (outLng !== last[0] || outLat !== last[1]) out.push(last);
  return out;
}

/**
 * Centroid of a MultiPolygon's largest ring by absolute (unprojected) area —
 * good enough at city scale, where the distortion from treating lat/lng as
 * planar over a few hundred metres is far below the resolution amenity
 * scoring acts on. `rings` is GeoJSON MultiPolygon coordinates:
 * Polygon[] -> LinearRing[] -> [lng, lat][], outer ring first in each polygon.
 */
export function multiPolygonCentroid(multiPolygonCoordinates) {
  let best = null;
  let bestArea = -1;

  for (const polygon of multiPolygonCoordinates) {
    const outerRing = polygon[0];
    if (!outerRing || outerRing.length < 3) continue;

    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < outerRing.length - 1; i++) {
      const [x0, y0] = outerRing[i];
      const [x1, y1] = outerRing[i + 1];
      const cross = x0 * y1 - x1 * y0;
      area += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    area /= 2;
    const absArea = Math.abs(area);
    if (absArea === 0) continue;
    if (absArea > bestArea) {
      bestArea = absArea;
      best = { lng: cx / (6 * area), lat: cy / (6 * area) };
    }
  }

  return best;
}
