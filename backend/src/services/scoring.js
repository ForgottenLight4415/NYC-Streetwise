import {
  BAND_THRESHOLDS,
  AMENITY_BAND_THRESHOLDS,
  BUCKET_NAMES,
  BUCKET_WEIGHTS,
  RADIUS_TIERS,
  SCORE_ANCHOR_PERCENTILES,
  SCORE_TAIL_MULTIPLIER,
  SCORE_DEGENERATE_SPAN,
  LOW_CONFIDENCE_BUCKETS,
  CONFIDENCE,
  CONFIDENCE_REASONS,
  WINDOW_MONTHS,
  AMENITY_TIERS,
  AMENITY_BUCKET_NAMES,
  AMENITY_WEIGHTS,
  AMENITY_MAX_METERS,
} from "../config/constants.js";

// Pure scoring. No network, no Mongo, no clock — everything here is a function
// of its arguments, so it is tested against committed fixtures.
//
// The whole point of scoring against a baseline rather than showing raw counts:
// "47 noise complaints" means nothing to a renter. "Quieter than 78% of NYC"
// does. The baseline is what makes this a score instead of a count map.

/**
 * Maps a 0-100 sub-score to its band. Higher score = fewer complaints = better.
 * Shared by the mock and the real scorer so thresholds live in exactly one place.
 */
export function bandFor(score) {
  if (score >= BAND_THRESHOLDS.good) return "good";
  if (score >= BAND_THRESHOLDS.fair) return "fair";
  return "poor";
}

/**
 * Maps an amenity sub-score to its band. Deliberately a different vocabulary
 * and different cutoffs from bandFor() above — see AMENITY_BAND_THRESHOLDS'
 * comment for why a citywide-percentile distance score needs its own scale
 * rather than reusing the complaint one.
 */
export function amenityBandFor(score) {
  if (score >= AMENITY_BAND_THRESHOLDS.excellent) return "excellent";
  if (score >= AMENITY_BAND_THRESHOLDS.typical) return "typical";
  return "carDependent";
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Anchor points [count, percentile] for one bucket's baseline, always with
 * strictly increasing counts so interpolation cannot divide by zero.
 *
 * TIES RESOLVE TO THE MOST FAVOURABLE PERCENTILE. Complaint counts are small
 * integers over a heavily zero-inflated distribution, so one count routinely
 * spans a wide percentile range — 45% of sampled buildings have zero heat
 * complaints, so "0" covers percentiles 0 through 45. Reporting the bottom of
 * that range is the honest reading of a tie ("tied for fewest in the city"),
 * and it is what guarantees a zero count always scores 100 rather than
 * inheriting a median of 0 and scoring 50.
 *
 * The dangerous side of that guarantee — zero because the lookup missed the
 * building, not because the building is clean — is caught by the low-confidence
 * marker in scoreTier, not by fudging the curve.
 *
 * `zeroShare` is what stops the curve from being nonsense on zero-inflated
 * buckets: it puts the first non-zero count at the TOP of the zero tie, so one
 * plumbing complaint reads as "worse than the 53% of the city with none"
 * instead of being interpolated as if it were halfway to the median.
 */
function anchorsFor(bucketBaseline) {
  const { median: medianPct, p90: p90Pct } = SCORE_ANCHOR_PERCENTILES;
  const median = Math.max(0, Number(bucketBaseline?.median) || 0);
  const p90 = Math.max(median, Number(bucketBaseline?.p90) || 0);
  const rawZeroShare = Number(bucketBaseline?.zeroShare);
  const zeroShare = Number.isFinite(rawZeroShare)
    ? clamp(rawZeroShare, 0, 1)
    : null;

  const anchors = [[0, 0]];

  if (zeroShare !== null && zeroShare > 0) {
    // Everything above zero starts above the whole zero tie.
    anchors.push([1, zeroShare * 100]);
  } else if (p90 === 0) {
    // Degenerate baseline with no zeroShare recorded: the bucket is essentially
    // always zero citywide, so a single complaint is already unusual.
    anchors.push([1, p90Pct]);
  }

  if (median > 0) anchors.push([median, medianPct]);
  if (p90 > 0) anchors.push([p90, p90Pct]);

  // Beyond p90 the baseline says nothing about shape, so extrapolate over a
  // multiple of the median→p90 spread. When median is 0 that spread is p90.
  const spread = p90 - median > 0 ? p90 - median : p90;
  anchors.push([
    p90 > 0 ? p90 + SCORE_TAIL_MULTIPLIER * spread : SCORE_DEGENERATE_SPAN,
    100,
  ]);

  return normalizeAnchors(anchors);
}

/**
 * Sorts anchors by count, collapses tied counts to their lowest percentile, and
 * drops any anchor that would make the curve non-monotonic. Without the last
 * step a bucket whose median sits below its zero-tie ceiling would produce a
 * curve where MORE complaints scored BETTER.
 */
function normalizeAnchors(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [count, percentile] of sorted) {
    const last = out[out.length - 1];
    if (!last) {
      out.push([count, percentile]);
      continue;
    }
    if (count <= last[0] || percentile <= last[1]) continue;
    out.push([count, percentile]);
  }
  // The final anchor must reach 100 and must sit strictly right of the previous
  // one, or a count past the end of the curve has nothing to interpolate to.
  const last = out[out.length - 1];
  if (last[1] < 100) out.push([last[0] + Math.max(1, last[0]), 100]);
  return out;
}

/**
 * Where `count` sits in the citywide distribution for its bucket: 0 = fewest
 * complaints in the city, 100 = worst. Piecewise-linear through the anchors.
 */
export function percentileFor(count, bucketBaseline) {
  const n = Number.isFinite(count) ? Math.max(0, count) : 0;
  const anchors = anchorsFor(bucketBaseline);

  if (n <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1];
    const [x1, y1] = anchors[i];
    if (n <= x1) return y0 + ((y1 - y0) * (n - x0)) / (x1 - x0);
  }
  return 100;
}

/** One bucket's 0-100 score. Inverted percentile: MORE complaints = LOWER score. */
export function bucketScore(count, bucketBaseline) {
  return clamp(100 - percentileFor(count, bucketBaseline), 0, 100);
}

/**
 * Weighted mean of a {key: score} map against a {key: weight} table. Shared
 * by complaint scoring (BUCKET_WEIGHTS, all 1 today) and amenity scoring
 * (AMENITY_WEIGHTS, subway weighted 2x) — extracted so a bucket's influence
 * is an explicit edit to its weight table rather than padding its
 * complaint_type/bucket list, the failure mode CLAUDE.md decision 6 warns
 * about.
 */
function weightedMean(scores, weights) {
  let weighted = 0;
  let totalWeight = 0;
  for (const [key, score] of Object.entries(scores)) {
    const weight = weights[key] ?? 1;
    weighted += score * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight;
}

function aggregate(bucketScores) {
  return weightedMean(bucketScores, BUCKET_WEIGHTS);
}

/**
 * Scores one radius tier into its slice of the frozen response shape.
 *
 * @param {"building"|"block"} tierName
 * @param {Record<string, number>} counts   summed per bucket (never per string)
 * @param {object|null} baseline            full baseline doc, or null if absent
 * @param {Record<string, Record<"open"|"in-progress"|"closed", number>>|null} [statusCounts]
 *   Per-bucket status breakdown from fetchCountsForTier/mockData, attached
 *   verbatim as `bucketStatusCounts` — purely descriptive, no scoring logic
 *   (bucketScore/aggregate/confidence) reads it. Trailing optional param, same
 *   convention as buildReport's `amenities`/`amenityBaseline` below, so every
 *   existing call site and test compiles unchanged. Omitted, the field is
 *   simply absent from the returned object rather than defaulted to a
 *   zero-filled one — that would claim a breakdown was computed when it
 *   wasn't (an old cache doc, or a caller that hasn't been updated).
 */
export function scoreTier(tierName, counts, baseline, statusCounts = null) {
  const buckets = BUCKET_NAMES[tierName];
  const { radiusMeters } = RADIUS_TIERS[tierName];
  const perBucket = baseline?.perBucket ?? null;

  const safeCounts = {};
  const bucketScores = {};
  for (const bucket of buckets) {
    // A missing bucket must not become NaN and silently poison the mean. The
    // provider zero-fills, but the mock and any hand-built payload may not.
    safeCounts[bucket] = Number.isFinite(counts?.[bucket]) ? counts[bucket] : 0;
    bucketScores[bucket] = Math.round(
      bucketScore(safeCounts[bucket], perBucket?.[bucket])
    );
  }

  const score = Math.round(aggregate(bucketScores));

  // Confidence, in priority order — the reason shown is the one that most
  // undermines the number.
  let confidence = CONFIDENCE.normal;
  let confidenceReason = null;

  if (!perBucket) {
    confidence = CONFIDENCE.low;
    confidenceReason = CONFIDENCE_REASONS.noBaseline;
  } else if (baselineRadiusMismatch(baseline, tierName)) {
    confidence = CONFIDENCE.low;
    confidenceReason = CONFIDENCE_REASONS.staleBaseline;
  } else if (buckets.every((bucket) => safeCounts[bucket] === 0)) {
    // Every bucket zero is far more likely to be a coordinate that missed its
    // building than a genuinely spotless one. Report the score, flag the doubt.
    confidence = CONFIDENCE.low;
    confidenceReason = CONFIDENCE_REASONS.noComplaintsFound;
  }

  // Only non-normal buckets are listed, so an empty object means "all solid".
  const bucketConfidence = {};
  for (const bucket of buckets) {
    if (bucket in LOW_CONFIDENCE_BUCKETS) {
      bucketConfidence[bucket] = CONFIDENCE.low;
    }
  }

  const result = {
    score,
    band: bandFor(score),
    counts: safeCounts,
    radiusMeters,
    confidence,
    confidenceReason,
    bucketScores,
    bucketConfidence,
  };
  if (statusCounts) result.bucketStatusCounts = statusCounts;
  return result;
}

/**
 * Scores one amenity tier (transit/parks/bike). Structurally parallel to
 * scoreTier above, with `metrics` in place of `counts`.
 *
 * Distances go through the SAME inverted percentile curve as complaint
 * counts, via bucketScore() — completely unmodified. 0m means standing on
 * it, which scores 100, exactly as 0 complaints does. That is not a
 * coincidence worth being clever about; it is why distance was chosen as the
 * amenity metric over, say, a count.
 *
 * A null distance (nothing within AMENITY_MAX_METERS) scores as the cap —
 * the worst measurable distance, not an invented worse-than-worst value —
 * and is flagged low-confidence per bucket. Reporting 0 for "none nearby"
 * would be indistinguishable from "one right here"; reporting the metric as
 * missing would silently zero it out of the weighted mean instead of scoring
 * it as genuinely bad.
 *
 * @param {"transit"|"parks"|"bike"} tierName
 * @param {Record<string, {meters: number|null, within: number, name: string|null}>} metrics
 * @param {object|null} amenityBaseline
 */
export function scoreAmenityTier(tierName, metrics, amenityBaseline) {
  const buckets = AMENITY_BUCKET_NAMES[tierName];
  const { radiusMeters } = AMENITY_TIERS[tierName];
  const perBucket = amenityBaseline?.perBucket ?? null;

  const safeMetrics = {};
  const bucketScores = {};
  for (const bucket of buckets) {
    const metric = metrics?.[bucket];
    safeMetrics[bucket] =
      metric && Number.isFinite(metric.within)
        ? metric
        : {
            meters: metric?.meters ?? null,
            within: metric?.within ?? 0,
            name: metric?.name ?? null,
            // Additive — see CLAUDE.md's routes contract-change note. Only
            // subway/bus metrics ever carry a real routes array; every other
            // bucket that lands in this fallback just gets an empty one, so
            // the field survives this reconstruction path too.
            routes: metric?.routes ?? [],
          };

    const distanceValue = safeMetrics[bucket].meters ?? AMENITY_MAX_METERS;
    bucketScores[bucket] = Math.round(bucketScore(distanceValue, perBucket?.[bucket]));
  }

  // Rail (LIRR/Metro-North) is a fallback transit mode, not a third leg
  // equal to subway/bus — most NYC addresses have no station within range,
  // and that absence means "not near commuter rail," not "no transit here."
  // Once subway or bus already answers "can this person get around," a
  // missing rail station stops being a strike against the tier, so it is
  // dropped from the average rather than scored as the worst-measurable
  // distance at full weight.
  const weights = { ...AMENITY_WEIGHTS };
  if (
    tierName === "transit" &&
    safeMetrics.rail?.meters === null &&
    (safeMetrics.subway?.meters !== null || safeMetrics.bus?.meters !== null)
  ) {
    weights.rail = 0;
  }

  const score = Math.round(weightedMean(bucketScores, weights));

  let confidence = CONFIDENCE.normal;
  let confidenceReason = null;

  if (!perBucket) {
    confidence = CONFIDENCE.low;
    confidenceReason = CONFIDENCE_REASONS.noBaseline;
  } else if (buckets.every((bucket) => safeMetrics[bucket].meters === null)) {
    confidence = CONFIDENCE.low;
    confidenceReason = CONFIDENCE_REASONS.noneNearby;
  }

  // Only non-normal buckets are listed, so an empty object means "all solid" —
  // same convention as scoreTier's bucketConfidence.
  const bucketConfidence = {};
  for (const bucket of buckets) {
    if (safeMetrics[bucket].meters === null) bucketConfidence[bucket] = CONFIDENCE.low;
  }

  return {
    score,
    band: amenityBandFor(score),
    metrics: safeMetrics,
    radiusMeters,
    confidence,
    confidenceReason,
    bucketScores,
    bucketConfidence,
  };
}

/**
 * A baseline is only meaningful for the radii it was sampled at — the same
 * address at 25m and 50m produces different counts. If someone retunes
 * RADIUS_TIERS without rerunning scripts/buildBaseline.js, every score silently
 * shifts. Detect that rather than serving numbers that look fine.
 */
function baselineRadiusMismatch(baseline, tierName) {
  const sampled = baseline?.radiusMeters?.[tierName];
  if (!Number.isFinite(sampled)) return false; // pre-radius baselines: trust it
  return sampled !== RADIUS_TIERS[tierName].radiusMeters;
}

/** tier name -> the ReportResponse field it scores into. */
const AMENITY_REPORT_KEYS = {
  transit: "transitAccess",
  parks: "parksAccess",
  bike: "bikeAccess",
  walkability: "walkabilityAccess",
};

/**
 * The full POST /api/score payload. `address` is always null — we do not geocode.
 *
 * @param {{building: object, block: object}} counts  bucket counts per tier
 * @param {object|null} baseline                      baseline doc, or null
 * @param {object} [meta]                              non-scoring extras (cache, etc.)
 * @param {{transit: object|null, parks: object|null, bike: object|null}|null} [amenities]
 *   getAmenityMetrics() result. Trailing optional param, so every existing
 *   call site and test compiles unchanged.
 * @param {object|null} [amenityBaseline]
 * @param {{building: object, block: object}|null} [statusCounts]
 *   Per-tier bucketStatusCounts (see scoreTier), passed straight through to
 *   each complaint tier. Trailing optional param, same convention as
 *   `amenities`/`amenityBaseline` above.
 */
export function buildReport(
  counts,
  baseline,
  meta = {},
  amenities = null,
  amenityBaseline = null,
  statusCounts = null
) {
  // Each amenity tier is included only when ITS OWN dataset loaded — not
  // gated on the other two, and not gated on `amenities` as a whole. A
  // dataset failing to load is not the same fact as "no subway/park/bike
  // nearby", so a tier whose dataset is absent is OMITTED from the response
  // rather than scored as if everything were maximally far away. See
  // CLAUDE.md's Amenity Scores section.
  const amenitySections = {};
  for (const [tierName, reportKey] of Object.entries(AMENITY_REPORT_KEYS)) {
    if (amenities?.[tierName]) {
      amenitySections[reportKey] = scoreAmenityTier(tierName, amenities[tierName], amenityBaseline);
    }
  }

  return {
    address: null,
    buildingHealth: scoreTier("building", counts?.building, baseline, statusCounts?.building),
    blockQuality: scoreTier("block", counts?.block, baseline, statusCounts?.block),
    ...amenitySections,
    meta: {
      windowMonths: WINDOW_MONTHS,
      baselineVersion: baseline?._id ?? null,
      baselineSource: baseline ? (baseline.source ?? null) : null,
      ...meta,
    },
  };
}
