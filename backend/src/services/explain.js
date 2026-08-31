import { RADIUS_TIERS, AMENITY_TIERS, EXPLANATION_SOURCES } from "../config/constants.js";
import { formatDistanceImperial } from "../lib/geo.js";
import { generateExplanation } from "../providers/ai/index.js";
import { templateExplanation } from "./templateExplanation.js";
import { amenityTemplateExplanation } from "./templateAmenityExplanation.js";
import { templateOverallSummary } from "./templateOverallSummary.js";

// Provider-agnostic explanation service. Never branches on AI_PROVIDER — that
// belongs to providers/ai/index.js and nowhere else.
//
// The single rule this file exists to enforce: an AI failure NEVER surfaces to
// the user. Every path returns a usable explanation and a truthful label saying
// where it came from.

/** Human-readable tier names, used in both the prompt and the template. */
export const TIER_LABELS = {
  building: "Building Health",
  block: "Block Quality",
  transit: "Transit Access",
  parks: "Parks Access",
  bike: "Bike Access",
  walkability: "Walkability",
};

/** Whether a tier is scored by distance (amenities) rather than complaint count. */
function isAmenityTier(tier) {
  return tier in AMENITY_TIERS;
}

/**
 * What the radius is measured FROM, per tier. A lookup table rather than a
 * ternary — the ternary this replaced (`tier === "building" ? ... : ...`)
 * silently mislabelled any third tier as "this block", which is exactly the
 * bug a fifth tier would have hit again if this had grown instead of been
 * fixed.
 */
const RADIUS_SUBJECTS = {
  building: "this building",
  block: "this block",
  // Amenity tiers all measure from the same point, unlike building/block —
  // there is no separate "amenity address" vs "amenity block" distinction.
  transit: "this location",
  parks: "this location",
  bike: "this location",
  walkability: "this location",
};

/** "this building (80 ft radius)" — gives the model the area it is describing. */
export function radiusLabelFor(tier) {
  const meters = RADIUS_TIERS[tier]?.radiusMeters ?? AMENITY_TIERS[tier]?.radiusMeters;
  const subject = RADIUS_SUBJECTS[tier] ?? "this location";
  return meters ? `${subject} (${formatDistanceImperial(meters)} radius)` : subject;
}

/**
 * Assembles the template input for one tier. Complaint tiers pass `counts`;
 * amenity tiers pass `metrics` instead — explainFromTemplate below dispatches
 * on which one is present, so the two shapes never need a third "kind" flag
 * threaded through every caller.
 */
export function explanationInputFor(tier, subScore) {
  const base = {
    label: TIER_LABELS[tier] ?? tier,
    band: subScore.band,
    radiusLabel: radiusLabelFor(tier),
  };
  return isAmenityTier(tier)
    ? { ...base, metrics: subScore.metrics }
    : { ...base, counts: subScore.counts };
}

/**
 * The template explanation — the ONLY explanation building/block/transit/
 * parks/bike/walkability ever get; none of the six per-section scores calls
 * the AI. That keeps the AI budget and the whole-report staleness bookkeeping
 * scoped to the one summary that actually spans the report — see
 * explainOverallWithAI below. Always available, no network, so /api/score
 * attaches it directly rather than needing a slow-path fetch.
 */
export function explainFromTemplate(tier, subScore) {
  const input = {
    ...explanationInputFor(tier, subScore),
    // Not part of the adapter contract, but the template can pick a better
    // bucket with it — raw counts/scores are not comparable across buckets.
    bucketScores: subScore.bucketScores,
  };
  return {
    explanation: isAmenityTier(tier) ? amenityTemplateExplanation(input) : templateExplanation(input),
    explanationSource: EXPLANATION_SOURCES.template,
  };
}

/** Which report key holds each tier, for assembling the whole-report summary. */
const OVERALL_SECTION_KEYS = {
  building: "buildingHealth",
  block: "blockQuality",
  transit: "transitAccess",
  parks: "parksAccess",
  bike: "bikeAccess",
  walkability: "walkabilityAccess",
};

/**
 * Flattens a full score report into the section list the overall-summary
 * prompt and its template fallback both read — one entry per tier the report
 * actually has (an amenity tier that failed to load is simply absent, same as
 * everywhere else in this report).
 */
export function overallSections(report) {
  return Object.entries(OVERALL_SECTION_KEYS)
    .map(([tier, key]) => {
      const section = report[key];
      if (!section) return null;
      const base = { label: TIER_LABELS[tier], band: section.band };
      return isAmenityTier(tier)
        ? { ...base, metrics: section.metrics }
        : { ...base, counts: section.counts, bucketScores: section.bucketScores };
    })
    .filter(Boolean);
}

/**
 * The template whole-report summary, always available, no network. What
 * /api/score serves for `summary` unless an AI summary is already cached.
 */
export function explainOverallFromTemplate(report) {
  return {
    explanation: templateOverallSummary(overallSections(report)),
    explanationSource: EXPLANATION_SOURCES.template,
  };
}

/**
 * The AI whole-report summary, with a guaranteed fallback. SLOW — only ever
 * called from GET /api/explanation?tier=overall, never from the score path.
 * This is the ONLY explanation in the app that ever calls the AI adapter —
 * see the doc comment on explainFromTemplate above.
 *
 * There is no "nothing to explain" short-circuit: even a report with zero
 * complaints anywhere can still have amenity facts worth a sentence, so
 * skipping the AI call on zero complaints would silence access information
 * that has nothing to do with why the complaint count is zero.
 *
 * @returns {Promise<{explanation: string, explanationSource: "ai"|"template", error?: string}>}
 */
export async function explainOverallWithAI(report) {
  try {
    const explanation = await generateExplanation({ sections: overallSections(report) });
    return { explanation, explanationSource: EXPLANATION_SOURCES.ai };
  } catch (err) {
    const reason = String(err?.message ?? err);
    console.warn("[explain] AI failed for overall summary, using template:", reason);
    return { ...explainOverallFromTemplate(report), error: reason };
  }
}
