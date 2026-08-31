import { amenityBucketLabel } from "../providers/ai/prompt.js";
import { AMENITY_WALK_METERS_PER_MIN } from "../config/constants.js";
import { formatDistanceImperial } from "../lib/geo.js";

// The deterministic fallback for amenity tiers (transit/parks/bike) —
// amenityService.js's analogue of templateExplanation.js. Same two hard
// requirements: cannot fail (no network, no I/O, every branch returns a
// string), and must read like a finished sentence, not a placeholder.
//
// Distance-shaped, not count-shaped: there is no dominantBucket() equivalent
// here, because "worst" for a distance metric is simply "farthest", and the
// nearest single amenity across the whole tier is what a reader actually
// wants to know first — a 2-minute subway beats three 12-minute buses, which
// dominantBucket()'s count/score-based tie-breaking has no notion of.

/** Rounds a distance to a walking-time estimate a reader can act on. */
function walkMinutes(meters) {
  return Math.max(1, Math.round(meters / AMENITY_WALK_METERS_PER_MIN));
}

/**
 * The closest metric across every bucket in the tier, or null if every
 * bucket is past AMENITY_MAX_METERS (metrics[bucket].meters === null).
 */
function nearestAcrossBuckets(metrics) {
  let best = null;
  for (const [bucket, metric] of Object.entries(metrics ?? {})) {
    if (metric?.meters === null || metric?.meters === undefined) continue;
    if (!best || metric.meters < best.meters) best = { bucket, ...metric };
  }
  return best;
}

/**
 * Builds the fallback amenity explanation.
 *
 * @param {object} input
 * @param {string} input.label    "Transit Access" | "Parks Access" | "Bike Access"
 * @param {string} input.band     "excellent" | "typical" | "carDependent" — unused
 *                                here; distance-derived text needs no band branch
 * @param {object} input.metrics  bucket -> {meters: number|null, within, name}
 * @returns {string} always a non-empty sentence
 */
export function amenityTemplateExplanation({ label, metrics = {} }) {
  const nearest = nearestAcrossBuckets(metrics);

  if (!nearest) {
    // A real, sometimes-correct answer — not a lookup failure the way an
    // all-zero building complaint tier usually is. Say so plainly.
    return `Nothing in this category was found within range. ${label} may be limited here.`;
  }

  const noun = amenityBucketLabel(nearest.bucket);
  const minutes = walkMinutes(nearest.meters);
  const walkPhrase = `about a ${minutes}-minute walk`;

  const distance = formatDistanceImperial(nearest.meters);
  if (nearest.name) {
    return `The nearest ${noun} is ${nearest.name}, ${walkPhrase} away (${distance}).`;
  }
  return `The nearest ${noun} is ${walkPhrase} away (${distance}).`;
}
