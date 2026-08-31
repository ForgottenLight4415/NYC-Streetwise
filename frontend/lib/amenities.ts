import type { AmenityMetric } from "./types";

/** Display label for one amenity bucket, across all four tiers. */
export const AMENITY_BUCKET_LABEL: Record<string, string> = {
  subway: "Subway",
  bus: "Bus",
  rail: "Commuter rail",
  park: "Park",
  playground: "Playground",
  garden: "Garden",
  bikeShare: "Bike share dock",
  bikeLane: "Bike lane",
  protectedLane: "Protected bike lane",
  grocery: "Grocery store",
  restaurant: "Restaurant",
  cafe: "Cafe",
  school: "School",
};

/**
 * Matches AMENITY_WALK_METERS_PER_MIN in the backend's constants.js (~4.8
 * km/h). Kept in exactly one place so no component invents its own
 * metres-to-minutes conversion.
 */
const METERS_PER_MIN = 80;

function walkMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / METERS_PER_MIN));
}

/** "3 min walk", or null when there is no distance to time. */
export function formatWalk(meters: number | null): string | null {
  if (meters === null) return null;
  return `${walkMinutes(meters)} min walk`;
}

/**
 * "1–3 min walk" spanning a set of distances (e.g. a station's per-entrance
 * meters) — collapses to the plain single-value form when every entrance
 * rounds to the same minute, so a tightly-clustered complex doesn't show a
 * pointless "2–2 min walk". Drives the row's own walk-time display in place
 * of `formatWalk(inst.meters)` whenever there's more than one entrance to
 * span, rather than only timing the single nearest door.
 */
export function formatWalkRange(metersList: number[]): string | null {
  if (metersList.length === 0) return null;
  const min = walkMinutes(Math.min(...metersList));
  const max = walkMinutes(Math.max(...metersList));
  return min === max ? `${min} min walk` : `${min}–${max} min walk`;
}

const METERS_PER_FOOT = 0.3048;
const METERS_PER_MILE = 1609.344;

/** Below this, show feet; at or above it, show miles. ~0.1 mile. */
const MILE_THRESHOLD_METERS = METERS_PER_MILE / 10;

/**
 * "70 ft" under ~0.1 mile, "0.3 mi" at or above it — the one place every
 * raw distance or radius in the app converts from meters (the source
 * datasets' native unit, and what every internal computation still uses)
 * to the imperial units the UI shows. Never format a distance ad hoc at a
 * call site; add a case here instead, the same rule `formatWalk` follows
 * for walk times.
 */
export function formatDistance(meters: number | null): string | null {
  if (meters === null) return null;
  if (meters < MILE_THRESHOLD_METERS) {
    const feet = Math.round(meters / METERS_PER_FOOT / 10) * 10;
    return `${feet} ft`;
  }
  const miles = meters / METERS_PER_MILE;
  return `${miles.toFixed(1)} mi`;
}

/**
 * "0.1 mi–0.4 mi" spanning a set of distances (e.g. a station's per-entrance
 * meters) — collapses to the plain single-value form when every entrance
 * rounds to the same display value, so a tightly-clustered complex doesn't
 * show a pointless "0.2 mi–0.2 mi". Each bound still goes through
 * formatDistance independently, so a range that straddles the ft/mi
 * threshold (e.g. "70 ft–0.3 mi") is shown honestly rather than forced into
 * one unit.
 */
export function formatDistanceRange(metersList: number[]): string | null {
  if (metersList.length === 0) return null;
  const min = formatDistance(Math.min(...metersList));
  const max = formatDistance(Math.max(...metersList));
  return min === max ? min : `${min}–${max}`;
}

/**
 * "a" or "an" for a spoken minute count — needed because a template that
 * always writes "a" produces "a 8 min walk" (should be "an"). Covers the
 * only vowel-sound starts a walk time in minutes ever hits: eight, eleven,
 * eighteen, and the eighty-something teens are never realistic here.
 */
function articleFor(minutes: number): "a" | "an" {
  return minutes === 8 || minutes === 11 || minutes === 18 ? "an" : "a";
}

/**
 * The nearest of a tier's buckets — what a panel's summary line leads with.
 * One 2-minute subway beats three 12-minute buses, so this compares metres,
 * never `within`.
 */
export function nearestMetric<TMetrics extends Record<string, AmenityMetric>>(
  metrics: TMetrics,
): { bucket: keyof TMetrics; metric: AmenityMetric } | null {
  let best: { bucket: keyof TMetrics; metric: AmenityMetric } | null = null;
  for (const bucket in metrics) {
    const metric = metrics[bucket];
    if (metric.meters === null) continue;
    if (best === null || metric.meters < (best.metric.meters as number)) {
      best = { bucket, metric };
    }
  }
  return best;
}

/**
 * The "Why this score?" copy for one amenity panel — the amenity-tier
 * analogue of ComplaintBreakdownBars' `explain()`. No AI, and none of the
 * four amenity tiers ever gets one from the backend either (see CLAUDE.md's
 * AI Explanation Layer section) — this is computed purely from the metrics
 * the panel is already showing, mirroring the backend's own deterministic
 * amenityTemplateExplanation.js ("nearest across every bucket") the same way
 * ComplaintBreakdownBars mirrors templateExplanation.js's dominant-bucket
 * logic. Two client-side implementations reaching different answers for
 * "which is nearest" would read as a bug, so this uses the SAME
 * `nearestMetric` the summary line above the breakdown already uses.
 */
export function explainAmenity(
  label: string,
  score: number,
  metrics: Record<string, AmenityMetric>,
): string {
  const nearest = nearestMetric(metrics);

  if (!nearest) {
    return `Nothing in this category was found within range, which is what is pulling ${label.toLowerCase()} down.`;
  }

  const noun = (
    AMENITY_BUCKET_LABEL[String(nearest.bucket)] ?? String(nearest.bucket)
  ).toLowerCase();
  const minutes = walkMinutes(nearest.metric.meters as number);
  const walk = `${articleFor(minutes)} ${minutes} min walk`;
  const named = nearest.metric.name ? ` (${nearest.metric.name})` : "";

  if (score >= 75) {
    return `${label} scores well because the nearest ${noun}${named} is close by, about ${walk} away.`;
  }
  if (score >= 50) {
    return `${label} is mid-range: the nearest ${noun}${named} is about ${walk} away — reachable, but not among the closest in the city.`;
  }
  return `${label} is limited mainly by distance — the nearest ${noun}${named} is about ${walk} away, farther than most of New York City.`;
}
