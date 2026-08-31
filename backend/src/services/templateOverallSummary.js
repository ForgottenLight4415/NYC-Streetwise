import { dominantBucket } from "./templateExplanation.js";
import { bucketLabel, amenityBucketLabel } from "../providers/ai/prompt.js";
import { AMENITY_WALK_METERS_PER_MIN } from "../config/constants.js";

// The deterministic fallback for the whole-report summary — the combined-blurb
// analogue of templateExplanation.js / templateAmenityExplanation.js. Same two
// hard requirements: cannot fail (no network, no I/O, every branch returns a
// string), and must read like a finished sentence, not a placeholder.
//
// Targets ~120 words / 3-5 sentences, matching buildOverallSummaryPrompt()'s
// AI target. The original ~100-word version picked AT MOST one complaint fact
// and one amenity fact across the WHOLE report. This version covers more
// ground — one fact for Building Health, one for Block Quality, and one per
// amenity TOPIC (transit; parks/bike combined; walkability) — but keeps the
// same "at most one fact per topic" discipline, just applied per topic
// instead of once globally: each topic still collapses to its single most
// notable bucket, never an enumeration of every bucket inside it. That is
// what keeps this reading as curated prose instead of a wall of per-bucket
// stats even though it now touches up to five topics instead of two.
//
// Section labels are matched against the literal strings TIER_LABELS in
// services/explain.js produces ("Building Health", "Block Quality", ...),
// hardcoded here rather than imported — the same convention
// templateExplanation.js's TIER_SUBJECTS already uses, and necessary here
// too since explain.js imports THIS file (importing TIER_LABELS back would
// be circular).

/** Sums a counts object defensively — never throws on missing/malformed input. */
function totalOf(counts) {
  return Object.values(counts ?? {}).reduce(
    (sum, n) => sum + (Number.isFinite(n) ? n : 0),
    0
  );
}

/** The closest metric across every bucket in a metrics object, or null. */
function nearestAcrossBuckets(metrics) {
  let best = null;
  for (const [bucket, metric] of Object.entries(metrics ?? {})) {
    if (metric?.meters === null || metric?.meters === undefined) continue;
    if (!best || metric.meters < best.meters) best = { bucket, ...metric };
  }
  return best;
}

/** Rounds a distance to a walking-time estimate, same as templateAmenityExplanation.js. */
function walkMinutes(meters) {
  return Math.max(1, Math.round(meters / AMENITY_WALK_METERS_PER_MIN));
}

function findSection(sections, label) {
  return sections.find((s) => s?.label === label) ?? null;
}

/** The two complaint tiers, each rendered independently — see file header. */
const COMPLAINT_TOPICS = [
  { label: "Building Health", subject: "This building", noun: "category" },
  { label: "Block Quality", subject: "The surrounding block", noun: "type" },
];

/**
 * One clause for a single complaint tier — its own dominant bucket, or an
 * honest "nothing filed" clause when the tier is all zero. Returns null only
 * when the tier itself is absent from the report.
 */
function complaintTopicClause(section, { subject, noun }) {
  if (!section) return null;
  const total = totalOf(section.counts);

  if (total === 0) {
    return `${subject} has no 311 complaints on record in the last 24 months`;
  }

  const bucket = dominantBucket({ counts: section.counts, bucketScores: section.bucketScores });
  const count = section.counts[bucket] ?? 0;
  const plural = count === 1 ? "complaint" : "complaints";
  return `${subject} stands out for ${bucketLabel(bucket)}, with ${count} ${plural} filed in the last 24 months, more than any other ${noun} here`;
}

/**
 * The three amenity TOPICS a summary covers — not the four amenity TIERS the
 * API returns. Parks and Bike are merged into one topic (their bucket names
 * never collide, so a plain object merge is safe) because both answer the
 * same underlying question — "can I get outside or get around without a car
 * here" — and folding them together is what keeps this at 3 amenity clauses
 * rather than 4, matching the two complaint clauses in scale.
 */
const AMENITY_TOPICS = [
  {
    labels: ["Transit Access"],
    zeroText: "no subway, bus, or rail stop was found within range of this location",
    lead: "The nearest transit option",
  },
  {
    labels: ["Parks Access", "Bike Access"],
    zeroText: "no parks or bike infrastructure was found within range of this location",
    lead: "For getting outside, the nearest option",
  },
  {
    labels: ["Walkability"],
    zeroText: "no grocery stores, restaurants, cafes, or schools were found within range of this location",
    lead: "For everyday errands, the nearest option",
  },
];

/**
 * One clause per amenity topic — the single nearest bucket across whichever
 * of the topic's underlying section(s) are present, or null if none of them
 * are in this report at all (as opposed to present-but-nothing-found, which
 * gets the topic's zeroText instead).
 */
function amenityTopicClause(sections, topic) {
  const matched = topic.labels
    .map((label) => findSection(sections, label))
    .filter(Boolean);
  if (matched.length === 0) return null;

  const merged = Object.assign({}, ...matched.map((s) => s.metrics ?? {}));
  const nearest = nearestAcrossBuckets(merged);
  if (!nearest) return topic.zeroText;

  const noun = amenityBucketLabel(nearest.bucket);
  const named = nearest.name ? ` (${nearest.name})` : "";
  const minutes = walkMinutes(nearest.meters);
  return `${topic.lead} is a ${noun}${named}, about a ${minutes}-minute walk away (${nearest.meters}m)`;
}

/**
 * Builds the fallback whole-report summary.
 *
 * @param {Array<{label: string, band: string, counts?: object, metrics?: object, bucketScores?: object}>} sections
 * @returns {string} always a non-empty sentence
 */
export function templateOverallSummary(sections = []) {
  const list = Array.isArray(sections) ? sections : [];

  const clauses = [
    ...COMPLAINT_TOPICS.map((topic) => complaintTopicClause(findSection(list, topic.label), topic)),
    ...AMENITY_TOPICS.map((topic) => amenityTopicClause(list, topic)),
  ].filter(Boolean);

  if (clauses.length === 0) {
    return "No standout complaints or amenities were found for this location.";
  }

  return clauses
    .map((clause) => `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`)
    .join(" ");
}
