// The prompt is SHARED by every adapter, deliberately. Llama 3 and Gemini
// Flash-Lite are different models; the only thing keeping their output feeling
// like one product is that they are asked the same question in the same words.
// Do not fork this per adapter — tighten it here instead.

/** Human-readable bucket names. The model should never see our camelCase keys. */
const BUCKET_LABELS = {
  heatHotWater: "heat and hot water",
  unsanitaryCondition: "unsanitary conditions",
  plumbing: "plumbing",
  noise: "noise",
  parking: "illegal parking and blocked driveways",
  streetCondition: "street and sidewalk condition",
};

export function bucketLabel(bucket) {
  return BUCKET_LABELS[bucket] ?? bucket;
}

/** Human-readable amenity bucket names, the amenity-tier analogue of BUCKET_LABELS. */
const AMENITY_BUCKET_LABELS = {
  subway: "subway station",
  bus: "bus stop",
  rail: "commuter rail station",
  park: "park",
  playground: "playground",
  garden: "garden",
  bikeShare: "Citi Bike dock",
  bikeLane: "bike lane",
  protectedLane: "protected bike lane",
  grocery: "grocery store",
  restaurant: "restaurant",
  cafe: "cafe",
  school: "school",
};

export function amenityBucketLabel(bucket) {
  return AMENITY_BUCKET_LABELS[bucket] ?? bucket;
}

/** "12 heat and hot water, 3 plumbing, 0 unsanitary conditions" */
function formatCounts(counts) {
  return Object.entries(counts ?? {})
    .map(([bucket, count]) => `${count} ${bucketLabel(bucket)}`)
    .join(", ");
}

/** "subway station 320m away (14 St-Union Sq), bus stop 120m away, rail station: none within 2000m" */
function formatMetrics(metrics) {
  return Object.entries(metrics ?? {})
    .map(([bucket, metric]) => {
      const noun = amenityBucketLabel(bucket);
      if (metric?.meters === null || metric?.meters === undefined) {
        return `${noun}: none found nearby`;
      }
      const named = metric.name ? ` (${metric.name})` : "";
      return `${noun} ${metric.meters}m away${named}`;
    })
    .join(", ");
}

/** "Building Health: 12 heat and hot water, 3 plumbing, 0 unsanitary conditions" */
function formatSection({ label, counts, metrics }) {
  return `${label}: ${metrics ? formatMetrics(metrics) : formatCounts(counts)}`;
}

/**
 * Builds the full prompt for the WHOLE-REPORT summary — one blurb synthesizing
 * across every section the report has (both complaint tiers, plus whichever
 * amenity tiers are present), rather than one prompt per section.
 *
 * This is the ONLY prompt the AI adapters build — building/block/transit/
 * parks/bike/walkability each get a deterministic "Why this score?" instead
 * (see explainFromTemplate in services/explain.js and its frontend mirrors),
 * so there is no per-section AI prompt to keep consistent with this one.
 *
 * @param {object} input
 * @param {Array<{label: string, band: string, counts?: object, metrics?: object}>} input.sections
 * @returns {string}
 */
export function buildOverallSummaryPrompt({ sections }) {
  return [
    "You summarize a full neighborhood report for someone deciding whether to rent an apartment in New York City.",
    "The report below is several independently rated sections. Each has already been labeled with a rating word for the reader elsewhere on the page (complaint sections: good, fair, or poor; amenity sections: excellent, typical, or car-dependent) — your job is not to rate anything, only to say what is actually worth knowing.",
    "",
    ...sections.map(formatSection),
    "",
    "Write ONE summary, under 120 words total (roughly 3-5 short sentences), covering only what stands out.",
    "",
    "Rules:",
    "- Mention only what is unusual: a notably high or low complaint count, or a notably close or far amenity. Most of the sections above will not be worth a sentence — do not describe every one of them.",
    "- If nothing stands out anywhere, say the area is generally unremarkable rather than listing numbers.",
    // Observed failure: a zero count rendered as "There is no heat or hot
    // water in the building" — a claim that the building HAS no heat, which
    // is the opposite of what a zero-complaint record means. The counts above
    // are a count of COMPLAINTS FILED, never a description of the physical
    // building or block, and the word "complaints" is what keeps that
    // distinction in the sentence.
    "- Every count above is a count of complaints FILED, not a fact about the building or block itself. When mentioning one, say so explicitly — \"no heat or hot water complaints\", never \"no heat or hot water\" — so a zero count never reads as a claim that the condition itself is absent or present.",
    "- Use ONLY the facts listed above. Do not invent addresses, dates, cross streets, landlords, or incidents.",
    "- Do not put quotation marks around complaint types, amenity names, counts, or distances.",
    "- Quote counts and distances exactly as given. Do not calculate ratios, percentages, averages, or 'X times more' comparisons, and do not convert metres to minutes, blocks, or miles.",
    "- Do not use the words good, fair, poor, excellent, typical, car-dependent, percentile, score, baseline, median, band, rating, data, or dataset.",
    "- Plain, calm, factual. No marketing language, no emoji, no bullet points, no headings.",
    "- Do not begin with a greeting, or with \"This report\", \"Overall\", or \"In summary\". Start with what a resident would actually notice.",
    "- Stay under 120 words total, no matter how many sections are listed above.",
    "",
    "Summary:",
  ].join("\n");
}
