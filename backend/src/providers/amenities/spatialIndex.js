// Uniform grid hash over a flat [lat, lng, nameIdx, ...] point array. Built
// once per dataset at load, then queried per request. No dependency.

import { haversineMeters } from "../../lib/geo.js";
import { AMENITY_GRID_DEGREES } from "../../config/constants.js";

function cellKey(lat, lng, gridDegrees) {
  const row = Math.floor(lat / gridDegrees);
  const col = Math.floor(lng / gridDegrees);
  return `${row},${col}`;
}

// Metres per degree of latitude is ~constant everywhere; metres per degree of
// LONGITUDE shrinks with cos(latitude), so a grid cell is narrower
// east-west than it is tall. Any bound on "how far away could the next ring
// possibly be" must use the SMALLER of the two, or it would overestimate the
// true minimum distance for cells reached in the east-west direction and
// could cut the search off before finding a genuinely closer point.
// cos(lat) across NYC's latitude range (40.4-40.95) sits in a narrow
// 0.756-0.762 band; 0.75 is a safe conservative floor for the whole city.
const METERS_PER_DEGREE_LAT = 111320;
const NYC_MIN_LNG_COS = 0.75;
const SAFE_METERS_PER_DEGREE = METERS_PER_DEGREE_LAT * NYC_MIN_LNG_COS;

/**
 * Builds an O(1)-ish nearest-neighbour index over a flat [lat, lng, nameIdx,
 * ...] array, paired with a parallel `names` array (nameIdx -1 = unnamed).
 *
 * Grid, not a k-d tree: cells are keyed on coordinates floored to
 * AMENITY_GRID_DEGREES (~0.005 deg, ~450m). nearestN() (which nearest() is a
 * one-result wrapper around) searches the containing cell, then expands ring
 * by ring (Chebyshev distance in grid cells), stopping once N candidates are
 * already held and the next ring cannot possibly beat the worst of them — so
 * it never scans the whole dataset for a query with a close match. The
 * minimum-possible-distance bound is intentionally conservative (see
 * SAFE_METERS_PER_DEGREE above): it may search a few more cells than
 * strictly necessary, but never fewer than necessary.
 *
 * @param {number[]} points flat [lat, lng, nameIdx, ...] triples
 * @param {string[]} names
 * @param {{gridDegrees?: number, routeSets?: string[][]|null, routeIdx?: number[]|null, complexIds?: string[]|null, complexIdIdx?: number[]|null}} [options]
 *   `routeSets`/`routeIdx` and `complexIds`/`complexIdIdx` are each OPTIONAL
 *   and additive — the transit dataset's subway bucket carries `complexIds`,
 *   subway/bus both carry `routeSets` (see providers/amenities/bikeShare.js's
 *   encodeBucket), every other bucket (parks, bike, rail) carries neither.
 *   When absent, nearestN()/allWithin()'s candidates carry NO `routes`/
 *   `complexId` key at all — not even an empty/null value — so a bucket with
 *   neither concept is byte-for-byte unchanged from before these fields
 *   existed. Both `Idx` arrays are parallel to points BY POINT INDEX (one
 *   entry per point, i.e. index i, not i*3), mirroring how `nameIdx` sits
 *   inside each point's own triple; -1 means "no data of that kind for this
 *   point".
 */
export function buildIndex(
  points,
  names,
  { gridDegrees = AMENITY_GRID_DEGREES, routeSets = null, routeIdx = null, complexIds = null, complexIdIdx = null } = {}
) {
  const cells = new Map();
  const n = points.length / 3;

  for (let i = 0; i < n; i++) {
    const lat = points[i * 3];
    const lng = points[i * 3 + 1];
    const key = cellKey(lat, lng, gridDegrees);
    let cell = cells.get(key);
    if (!cell) {
      cell = [];
      cells.set(key, cell);
    }
    cell.push(i);
  }

  const safeCellSizeMeters = gridDegrees * SAFE_METERS_PER_DEGREE;

  // Minimum possible ground distance from a query point to any cell at
  // Chebyshev grid-distance `ring` away. A query point can sit anywhere in
  // its own cell, including right at the edge of the next ring, so ring 1's
  // minimum is 0; each additional ring adds one full (safe) cell width.
  function ringMinDistance(ring) {
    return Math.max(0, ring - 1) * safeCellSizeMeters;
  }

  /**
   * The `count` nearest points, closest first, each past `maxMeters` excluded.
   * Ring expansion stops once `count` candidates are already held AND the next
   * ring cannot possibly beat the current worst of them — the same
   * stopping rule `nearest()` uses, generalised from "beat the one best" to
   * "beat the Nth best".
   *
   * @returns {{meters: number, name: string|null, lat: number, lng: number, routes?: string[], complexId?: string|null}[]}
   *   Includes each candidate's own coordinates — unlike a single nearest()
   *   answer, a caller of this (Google Routes matrix batching) needs a real
   *   destination to route to, not just a distance. `routes` is present only
   *   when this index was built with routeSets/routeIdx (see buildIndex).
   */
  function nearestN(lat, lng, count, maxMeters) {
    if (n === 0 || count <= 0) return [];

    const row = Math.floor(lat / gridDegrees);
    const col = Math.floor(lng / gridDegrees);
    const maxRing = Math.ceil(maxMeters / safeCellSizeMeters) + 1;

    let candidates = [];

    for (let ring = 0; ring <= maxRing; ring++) {
      if (candidates.length >= count && ringMinDistance(ring) > candidates[count - 1].meters) {
        break;
      }

      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          // Only the new outer shell of this ring — inner cells were already
          // visited in a previous iteration.
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const cell = cells.get(`${row + dr},${col + dc}`);
          if (!cell) continue;
          for (const i of cell) {
            const meters = haversineMeters(lat, lng, points[i * 3], points[i * 3 + 1]);
            if (meters > maxMeters) continue;
            const nameIdx = points[i * 3 + 2];
            const candidate = {
              meters,
              name: nameIdx >= 0 ? names[nameIdx] : null,
              lat: points[i * 3],
              lng: points[i * 3 + 1],
            };
            // Only set on an index actually built with route/complex data —
            // see the buildIndex JSDoc above. Keeps every other bucket's
            // candidate shape identical to before these fields existed.
            if (routeIdx) {
              const rIdx = routeIdx[i];
              candidate.routes = rIdx !== undefined && rIdx !== -1 && routeSets ? routeSets[rIdx] : [];
            }
            if (complexIdIdx) {
              const cIdx = complexIdIdx[i];
              candidate.complexId =
                cIdx !== undefined && cIdx !== -1 && complexIds ? complexIds[cIdx] : null;
            }
            candidates.push(candidate);
          }
        }
      }

      candidates.sort((a, b) => a.meters - b.meters);
      if (candidates.length > count) candidates.length = count;
    }

    return candidates;
  }

  /** @returns {{meters: number, name: string|null}|null} null past maxMeters. */
  function nearest(lat, lng, maxMeters) {
    return nearestN(lat, lng, 1, maxMeters)[0] ?? null;
  }

  /** @returns {number} how many points fall inside radiusMeters. */
  function countWithin(lat, lng, radiusMeters) {
    if (n === 0) return 0;
    const row = Math.floor(lat / gridDegrees);
    const col = Math.floor(lng / gridDegrees);
    const ringSpan = Math.ceil(radiusMeters / safeCellSizeMeters) + 1;

    let count = 0;
    for (let dr = -ringSpan; dr <= ringSpan; dr++) {
      for (let dc = -ringSpan; dc <= ringSpan; dc++) {
        const cell = cells.get(`${row + dr},${col + dc}`);
        if (!cell) continue;
        for (const i of cell) {
          const d = haversineMeters(lat, lng, points[i * 3], points[i * 3 + 1]);
          if (d <= radiusMeters) count++;
        }
      }
    }
    return count;
  }

  /**
   * Every point within radiusMeters, closest first, capped at `limit`.
   *
   * Same ring/cell traversal as countWithin — the exhaustive square-over-
   * radiusMeters scan, not nearestN's early-stopping ring expansion, since
   * every match within range must be found before they can be sorted and
   * capped, not just counted. COLLECTS each match's shape ({meters, name,
   * lat, lng, routes?}) — identical to a nearestN candidate, including the
   * same optional `routes` passthrough — instead of just incrementing a
   * counter the way countWithin does.
   *
   * @param {{limit?: number}} [options] `limit` (default 50) bounds the
   *   returned array — a bucket can legitimately have more than that within
   *   800m in dense Manhattan, and a caller (the amenity browser modal)
   *   doesn't need an unbounded list. Use countWithin() alongside this to
   *   detect truncation cheaply, without materialising every match just to
   *   count them.
   * @returns {{meters: number, name: string|null, lat: number, lng: number, routes?: string[], complexId?: string|null}[]}
   */
  function allWithin(lat, lng, radiusMeters, { limit = 50 } = {}) {
    if (n === 0) return [];
    const row = Math.floor(lat / gridDegrees);
    const col = Math.floor(lng / gridDegrees);
    const ringSpan = Math.ceil(radiusMeters / safeCellSizeMeters) + 1;

    const matches = [];
    for (let dr = -ringSpan; dr <= ringSpan; dr++) {
      for (let dc = -ringSpan; dc <= ringSpan; dc++) {
        const cell = cells.get(`${row + dr},${col + dc}`);
        if (!cell) continue;
        for (const i of cell) {
          const meters = haversineMeters(lat, lng, points[i * 3], points[i * 3 + 1]);
          if (meters > radiusMeters) continue;
          const nameIdx = points[i * 3 + 2];
          const match = {
            meters,
            name: nameIdx >= 0 ? names[nameIdx] : null,
            lat: points[i * 3],
            lng: points[i * 3 + 1],
          };
          // Same routeIdx/routeSets and complexIdIdx/complexIds passthrough
          // as nearestN — see buildIndex's JSDoc above.
          if (routeIdx) {
            const rIdx = routeIdx[i];
            match.routes = rIdx !== undefined && rIdx !== -1 && routeSets ? routeSets[rIdx] : [];
          }
          if (complexIdIdx) {
            const cIdx = complexIdIdx[i];
            match.complexId = cIdx !== undefined && cIdx !== -1 && complexIds ? complexIds[cIdx] : null;
          }
          matches.push(match);
        }
      }
    }

    matches.sort((a, b) => a.meters - b.meters);
    if (matches.length > limit) matches.length = limit;
    return matches;
  }

  return { nearest, nearestN, countWithin, allWithin };
}
