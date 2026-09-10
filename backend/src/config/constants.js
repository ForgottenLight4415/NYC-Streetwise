// Single source of truth for complaint-type strings, radii, time window, and
// thresholds. Do NOT re-derive complaint_type strings anywhere else — import
// from here. See CLAUDE.md for why each type is included or excluded.

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

export const SOCRATA_DATASET_ID = "erm2-nwe9";
export const SOCRATA_ENDPOINT = `https://data.cityofnewyork.us/resource/${SOCRATA_DATASET_ID}.json`;

// The geo-typed column used by within_circle(). CONFIRMED live in M2: it is a
// Point geometry, and the `latitude`/`longitude` fields are plain numbers that
// within_circle REJECTS with query.soql.type-mismatch. Do not "simplify" this.
export const LOCATION_FIELD = "location";

// ---------------------------------------------------------------------------
// Buckets — CONFIRMED against live API, see CLAUDE.md
// ---------------------------------------------------------------------------

export const BUILDING_HEALTH_TYPES = {
  heatHotWater: ["HEAT/HOT WATER", "Heat/Hot Water"],
  unsanitaryCondition: ["UNSANITARY CONDITION", "Unsanitary Condition"],
  plumbing: ["PLUMBING", "Plumbing"],
};

export const BLOCK_QUALITY_TYPES = {
  noise: [
    "Noise - Residential",
    "Noise - Street/Sidewalk",
    "Noise - Vehicle",
    "Noise - Commercial",
  ],
  parking: ["Illegal Parking", "Blocked Driveway"],
  streetCondition: ["Street Condition", "Sidewalk Condition", "DEP Street Condition"],
};

// ---------------------------------------------------------------------------
// Radius tiers
// ---------------------------------------------------------------------------

export const RADIUS_TIERS = {
  building: {
    tier: "building",
    radiusMeters: 25,
    buckets: BUILDING_HEALTH_TYPES,
  },
  block: {
    tier: "block",
    radiusMeters: 350,
    buckets: BLOCK_QUALITY_TYPES,
  },
};

/** Bucket names in a stable order, per tier. */
export const BUCKET_NAMES = {
  building: Object.keys(BUILDING_HEALTH_TYPES),
  block: Object.keys(BLOCK_QUALITY_TYPES),
};

/**
 * Flat lookup: complaint_type string -> bucket name. Used to sum all string
 * variants of a bucket into ONE number. Critical: never percentile per string
 * and average — buckets have different variant counts (see CLAUDE.md).
 */
export const TYPE_TO_BUCKET = Object.fromEntries(
  Object.values(RADIUS_TIERS).flatMap(({ buckets }) =>
    Object.entries(buckets).flatMap(([bucket, types]) =>
      types.map((type) => [type, bucket])
    )
  )
);

/** Every complaint_type string we care about, for the `in (...)` clause. */
export const ALL_COMPLAINT_TYPES = Object.keys(TYPE_TO_BUCKET);

// ---------------------------------------------------------------------------
// Status buckets — CONFIRMED against live API
// ---------------------------------------------------------------------------

/**
 * Raw `status` string -> one of three user-facing buckets.
 *
 * Confirmed against the live dataset 2026-08-17 via $select=status,count(*)
 * &$group=status. EIGHT distinct values exist, not three:
 *   Closed 21,705,379 | In Progress 269,249 | Open 95,898 | Pending 63,068
 *   Assigned 24,412   | Started 5,318       | Unspecified 2,794 | Cancel 1
 *
 * The buckets encode two questions at once: is it resolved, and has anyone
 * acted on it? So Assigned/Started/Pending sit with In Progress — work has
 * begun — and Cancel sits with Closed as a terminal state.
 *
 * "Unspecified" -> open, deliberately NOT in-progress. It carries no evidence
 * that anyone acted, and for someone deciding on a lease, claiming progress we
 * cannot evidence is the worse error. Unknown future values default the same
 * way; see statusBucket().
 *
 * Do not re-derive these strings elsewhere — import from here, exactly as with
 * TYPE_TO_BUCKET above.
 */
export const STATUS_TO_BUCKET = {
  Closed: "closed",
  Cancel: "closed",
  "In Progress": "in-progress",
  Pending: "in-progress",
  Assigned: "in-progress",
  Started: "in-progress",
  Open: "open",
  Unspecified: "open",
};

/** The three buckets, in the order the UI offers them. */
export const STATUS_BUCKET_NAMES = ["open", "in-progress", "closed"];

/**
 * Total by construction: an unrecognised status must never drop a row from a
 * filtered list, so it falls back to "open" rather than to undefined.
 */
export function statusBucket(raw) {
  return STATUS_TO_BUCKET[raw] ?? "open";
}

/** Every raw status we know how to bucket, for building an upstream filter. */
export const KNOWN_STATUSES = Object.keys(STATUS_TO_BUCKET);

/**
 * The raw `status` values that fall in one bucket — the inverse of
 * STATUS_TO_BUCKET, so a query can filter upstream instead of after the fact.
 *
 * Note this is NOT sufficient on its own for "open". statusBucket() sends
 * anything unrecognised there too, so a caller filtering to open must also
 * match NULL and any value outside KNOWN_STATUSES; see
 * fetchComplaintsForGroup(). Exported from here rather than inlined at the call
 * site for the same reason as STATUS_TO_BUCKET itself: one copy of the enum.
 */
export function rawStatusesForBucket(bucket) {
  return KNOWN_STATUSES.filter((raw) => STATUS_TO_BUCKET[raw] === bucket);
}

// ---------------------------------------------------------------------------
// Time window
// ---------------------------------------------------------------------------

/** Trailing window for complaint counts. Tunable. */
export const WINDOW_MONTHS = 24;

/** Floating ISO cutoff for `created_date > ...`, computed at query time. */
export function windowCutoffISO(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - WINDOW_MONTHS);
  return cutoff.toISOString().slice(0, 19); // Socrata floating timestamp, no Z
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// Sub-score is the mean of the three bucket percentiles. Equal weights are the
// starting point; if a bucket ever needs its own weight it must be set here
// explicitly rather than by padding its type list (see CLAUDE.md decision 6).
export const BUCKET_WEIGHTS = {
  heatHotWater: 1,
  unsanitaryCondition: 1,
  plumbing: 1,
  noise: 1,
  parking: 1,
  streetCondition: 1,
};

/** Score is 0-100 where 100 = fewest complaints. Bands are inclusive lower bounds. */
export const BAND_THRESHOLDS = {
  good: 70,
  fair: 40,
  // below `fair` => "poor"
};

/**
 * Amenity-tier band thresholds — deliberately lower and differently worded
 * than BAND_THRESHOLDS above. These scores are a citywide PERCENTILE
 * (services/scoring.js's bucketScore()), so 50 already means "typical NYC
 * distance to a subway/bus stop" — which, because the city is transit-dense
 * to begin with, is a perfectly fine outcome, not a middling one. Reusing
 * the complaint thresholds (good >= 70) would label a normal NYC walk
 * "poor" or "fair", which reads as a defect that isn't there. Inclusive
 * lower bounds, same convention as BAND_THRESHOLDS.
 */
export const AMENITY_BAND_THRESHOLDS = {
  excellent: 65,
  typical: 35,
  // below `typical` => "carDependent"
};

/**
 * The baseline gives us three points of the citywide distribution per bucket:
 * median, p90, and zeroShare (what fraction of sampled locations had none).
 * These are the percentiles median and p90 sit at; they anchor the
 * piecewise-linear curve that turns a raw count into a percentile. zeroShare
 * anchors the curve at count 1 — see anchorsFor() in services/scoring.js.
 */
export const SCORE_ANCHOR_PERCENTILES = {
  median: 50,
  p90: 90,
};

/**
 * Above p90 the baseline tells us nothing about shape, so the curve is
 * extrapolated: percentile reaches 100 at `p90 + TAIL * (p90 - median)`.
 * 2 keeps a genuinely awful block distinguishable from a merely bad one
 * instead of flattening every outlier to a score of 0.
 */
export const SCORE_TAIL_MULTIPLIER = 2;

/**
 * Degenerate baselines (median AND p90 both 0 — a bucket that is essentially
 * always zero citywide) carry no spread to interpolate over. One complaint is
 * then already unusual, and percentile reaches 100 at this many complaints.
 */
export const SCORE_DEGENERATE_SPAN = 10;

/**
 * Buckets whose underlying data is known to be weaker, surfaced per-bucket in
 * the response so the frontend can de-emphasize them rather than presenting
 * them as equally solid. streetCondition is 25.6% null-geocoded and the nulls
 * are NOT uniform by borough (19.1% Manhattan → 31.1% Queens), so the bias does
 * not cancel against the baseline. See handoff.md decision A.
 */
export const LOW_CONFIDENCE_BUCKETS = {
  streetCondition: "high_null_geocoding_rate",
};

/** Values for the `confidence` field on each sub-score. */
export const CONFIDENCE = {
  normal: "normal",
  low: "low",
};

/**
 * Reasons a sub-score is marked low-confidence.
 * - noComplaintsFound: every bucket is 0. A mid-street coordinate returns zero
 *   building complaints, which would otherwise score as a PERFECT building —
 *   a lookup failure presented to a renter as good news. See handoff.md B.
 * - noBaseline: no baseline available, so the score is not comparable to the city.
 * - staleBaseline: baseline was computed at different radii than we now query.
 */
export const CONFIDENCE_REASONS = {
  noComplaintsFound: "no_complaints_found",
  noBaseline: "no_baseline",
  staleBaseline: "stale_baseline_radius",
  // Amenity-specific: every bucket in the tier came back past AMENITY_MAX_METERS.
  // Distinct from noComplaintsFound — "nothing found" for an amenity is a real,
  // sometimes-correct answer (Staten Island genuinely has no nearby subway),
  // not primarily a lookup-failure signal the way an all-zero building tier is.
  noneNearby: "none_within_range",
};

// ---------------------------------------------------------------------------
// Socrata client
// ---------------------------------------------------------------------------

/**
 * 25s, not the 5s this used to be.
 *
 * Measured 2026-08-17 across 12 locations: a cold `within_circle` query ranges
 * 0.4s to 33.1s with no stable correlation to row count, to warmth, or to
 * location — re-running the same query immediately after was sometimes SLOWER.
 * At 5s a large share of legitimate queries exhausted the retry budget and 503'd.
 * Vercel Fluid Compute allows 300s, so 25s x 3 attempts is comfortably inside it.
 */
export const SOCRATA_TIMEOUT_MS = 25000;
export const SOCRATA_MAX_RETRIES = 2;

/** Socrata's own hard ceiling on $limit for a single SODA 2.0 request. */
export const SOCRATA_ROW_LIMIT = 50000;

/**
 * Row caps for the heatmap endpoint (individual points, not counts).
 * Socrata returns the most RECENT rows, so a dense block hitting the cap loses
 * its older months — the endpoint reports that truncation in a response header
 * rather than passing off a partial window as complete. Never count from this
 * endpoint; counts come from /api/score, which aggregates server-side.
 */
export const COMPLAINTS_DEFAULT_LIMIT = 1000;
export const COMPLAINTS_MAX_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Grouped complaint cache (/api/complaints?complete=1)
// ---------------------------------------------------------------------------

/**
 * Grouped (day, complaint_type, status) rows stored per address+tier.
 *
 * Sized from 12 measured locations (2026-08-17). The densest is Ludlow St at
 * 2,929 grouped rows over 24 months, so 10,000 is ~3.4x headroom. At ~100B per
 * grouped row (measured) that is ~1MB, far under Mongo's 16MB document cap and
 * far under SOCRATA_ROW_LIMIT.
 *
 * Grouping is what makes the extreme case tractable at all. 655 E 230 St in the
 * Bronx carries 190,205 raw rows inside a 350m/24mo window — past Socrata's own
 * $limit, so NO raw-row cache size could ever have held it — but only 1,848
 * grouped rows, a 102.9x collapse. Note the maximum is not that address:
 * volume concentrated in one type/status compresses hardest, so it is type
 * DIVERSITY that drives the group count, not volume.
 *
 * A theoretical ceiling of 730 days x 9 block types x 8 statuses = 52,560 does
 * exist and would exceed SOCRATA_ROW_LIMIT, but nothing measured came within
 * 17x of it. Truncation stays possible, and stays reported in a header.
 */
export const COMPLAINT_GROUPS_CACHE_LIMIT = 10000;

/** Deep $offset paging is slow upstream; bound it to what we actually store. */
export const COMPLAINTS_MAX_OFFSET = COMPLAINT_GROUPS_CACHE_LIMIT;

/** Page sizes the complaints browser offers. */
export const COMPLAINTS_PAGE_SIZES = [25, 50, 100, 200];

/**
 * The grouped fill gets its own budget, well above SOCRATA_TIMEOUT_MS.
 *
 * Measured 2.3-74.3s: server-side aggregation costs MORE than the raw fetch it
 * replaces, even though it returns ~100x less data at the extreme address. 120s
 * covers the observed worst case with margin, and retries drop to 1 so the
 * ceiling (2 x 120s + backoff) stays inside Vercel's 300s limit.
 */
export const COMPLAINT_FILL_TIMEOUT_MS = 120000;
export const COMPLAINT_FILL_RETRIES = 1;

// ---------------------------------------------------------------------------
// Trend windows (/api/trend)
// ---------------------------------------------------------------------------

/**
 * Selectable windows for the trend chart, in months.
 *
 * A closed set rather than any integer: each value is a distinct cache key and
 * a distinct upstream query, so leaving it open would let a caller spray the
 * cache and Socrata with 24 near-identical variants for no user benefit.
 * Capped at WINDOW_MONTHS because nothing above it is scored.
 */
export const TREND_WINDOW_OPTIONS = [3, 6, 9, 12, 18, 24];

/**
 * Nine months is the default because the audience is someone deciding on a
 * lease in the next few weeks: it spans a full heating season (the dominant
 * Building Health signal) plus a summer (the dominant noise signal) without
 * dragging in history from two tenants ago. It is also the fastest window
 * measured — median ~1.0s cold, against ~1.6s for 24 months.
 */
export const TREND_DEFAULT_MONTHS = 9;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export const CACHE_COLLECTION = "complaint_cache";

/**
 * Trends live in their own collection rather than on the counts document,
 * because writeCounts() REPLACES that document — a counts refresh would drop
 * the trends with it, and unlike an explanation a trend is not invalidated by
 * new counts arriving.
 */
export const TREND_CACHE_COLLECTION = "trend_cache";

/**
 * Grouped complaint rows, same reasoning as the trend cache: writeCounts()
 * REPLACES the counts document, so anything stored alongside it is dropped on
 * the next refresh.
 */
export const COMPLAINT_GROUPS_COLLECTION = "complaint_groups_cache";

/**
 * Which address text names which coordinate.
 *
 * NOT a cache, and so deliberately WITHOUT a TTL index: the three collections
 * above hold copies of city data that must expire, while this holds the mapping
 * needed to name a coordinate at all. Nothing else in the system stores an
 * address — /api/score is coordinate-only and answers with `address: null` — so
 * if this expired alongside the counts there would be no way to re-warm an
 * address, or to label a cached score on the homepage.
 *
 * Holds public address text and a lookup counter. No caller identity, no
 * session, nothing tying a row to a person.
 */
export const ADDRESS_LOOKUPS_COLLECTION = "address_lookups";
export const BASELINE_COLLECTION = "baseline";
export const BASELINE_ID = "v1";

/** Longest address string accepted by POST /api/lookups. */
export const ADDRESS_MAX_LENGTH = 200;

/** Cap on GET /api/showcase's `limit`, and its default. */
export const SHOWCASE_MAX_LIMIT = 12;
export const SHOWCASE_DEFAULT_LIMIT = 6;

/**
 * How many directory rows to consider per requested showcase item.
 *
 * The directory outlives the 24h counts cache, so a row is only usable if its
 * counts are still there. Over-fetching means a run of expired rows does not
 * empty the homepage; 3x was picked to cover a mostly-cold cache without
 * scoring the whole directory on every request.
 */
export const SHOWCASE_CANDIDATE_FACTOR = 3;

/** Showcase read modes. Closed set — each is a different sort, not a filter. */
export const SHOWCASE_MODES = ["top", "recent", "random"];

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------
//
// Ceilings per caller per minute, sized against what ONE person browsing the app
// actually does, then given generous headroom. Opening a report fires /api/score
// plus two /api/complaints plus a /api/trend plus up to two /api/explanation —
// roughly six upstream-capable calls per address viewed. The limits below let a
// person open a new address every few seconds and never notice them; a script
// looping over coordinates hits them immediately.
//
// Tiered by what a call COSTS us, not by how the request looks:

/** Anything that can reach Socrata on a miss: /api/score, /api/trend, drill-ins. */
export const RATE_LIMIT_UPSTREAM = { limit: 60, windowMs: 60_000 };

/**
 * The grouped complaint fill (`complete=1`), measured 2.3-74.3s per cold
 * address. The single most expensive thing an anonymous caller can trigger, so
 * it is priced separately from the cheap default mode of the same endpoint.
 */
export const RATE_LIMIT_FILL = { limit: 10, windowMs: 60_000 };

/**
 * /api/explanation. Tighter than the Socrata tier because this one spends money
 * on a metered API key rather than quota on a free public dataset, and because
 * a cached explanation costs nothing to re-serve — a caller legitimately needs
 * this at most twice per address.
 */
export const RATE_LIMIT_AI = { limit: 30, windowMs: 60_000 };

/**
 * POST /api/lookups, which is secret-gated and server-to-server only.
 *
 * A circuit breaker rather than per-user fairness: every legitimate call arrives
 * from ONE caller (our frontend server), so a per-IP budget sized for a person
 * would throttle every visitor of the site at once. Generous enough that real
 * traffic never sees it, small enough to stop a runaway loop on our own side.
 */
export const RATE_LIMIT_INTERNAL = { limit: 600, windowMs: 60_000 };

/** Cache-only reads (/api/showcase). Cheap, but not free to hammer. */
export const RATE_LIMIT_READ = { limit: 240, windowMs: 60_000 };

/**
 * Distinct caller keys held in memory before the whole table is dropped.
 *
 * The limiter's own bookkeeping must not become the memory exhaustion it exists
 * to prevent: one entry per caller, uncollected, is unbounded growth driven by
 * anyone who can vary an address or spoof a forwarding header.
 */
export const RATE_LIMIT_MAX_KEYS = 20_000;

// ---------------------------------------------------------------------------
// Baseline sampling (scripts/buildBaseline.js)
// ---------------------------------------------------------------------------

/** How many sample coordinates the baseline is computed over. */
export const BASELINE_SAMPLE_SIZE = 250;

/** Concurrent getCounts calls while sampling. Two HTTP calls each — be polite. */
export const BASELINE_SAMPLE_CONCURRENCY = 4;

/**
 * Fixed PRNG seed for sample selection. Sampling is deterministic on purpose:
 * a rerun picks the SAME coordinates, so it hits the cache instead of paying
 * for 500 fresh Socrata calls, and two runs are comparable.
 */
export const BASELINE_SAMPLE_SEED = 20260815;

/**
 * Sample points closer together than this share a grid cell and only one is
 * kept, so the baseline is not dominated by one complaint-dense block.
 * 0.003 degrees ≈ 330m, roughly the block radius.
 */
export const BASELINE_THINNING_GRID_DEGREES = 0.003;

/**
 * Minimum share of the sample each borough gets regardless of its record count.
 * Without a floor, Staten Island (fewest 311 records) would barely appear, and
 * the baseline would describe dense Brooklyn/Queens rather than the city.
 */
export const BASELINE_MIN_BOROUGH_SHARE = 0.08;

/** Borough values as they appear in the `borough` column. */
export const BOROUGHS = [
  "MANHATTAN",
  "BROOKLYN",
  "QUEENS",
  "BRONX",
  "STATEN ISLAND",
];

/** Coordinates are rounded to this many decimals to form the cache key (~11m). */
export const CACHE_COORD_PRECISION = 4;

/** TTL index expiry on createdAt — cache self-refreshes daily. */
export const CACHE_TTL_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// AI explanation layer
// ---------------------------------------------------------------------------

export const AI_PROVIDERS = {
  ollama: "ollama",
  gemini: "gemini",
};

/** Used when AI_PROVIDER is unset. Local dev is the default environment. */
export const DEFAULT_AI_PROVIDER = AI_PROVIDERS.ollama;

/**
 * Model strings live HERE and nowhere else — CLAUDE.md calls this out
 * specifically so a deprecation is a one-line swap. Both are env-overridable so
 * a deployment can change models without a code change. That design was
 * immediately vindicated; see the Gemini note.
 *
 * GEMINI note (verified live 2026-08-15): CLAUDE.md specifies
 * `gemini-2.5-flash-lite` and expects it to last until its 2026-10-16 shutdown.
 * It does NOT — it already returns
 *   404 "This model is no longer available to new users"
 * for a newly-issued API key. `gemini-3.5-flash-lite` is the current
 * equivalent tier: available, ~0.8s, and it needs no thinking config (see
 * GEMINI_THINKING_BUDGET below). Swapped, not worked around.
 *
 * OLLAMA note: CLAUDE.md specifies "llama3". The machine this was built on has
 * `llama3.1:8b` pulled and not `llama3`, so that is the default here — one
 * constant (or one env var) to change back, and nothing else knows the name.
 */
export const AI_MODELS = {
  ollama: process.env.OLLAMA_MODEL || "llama3.1:8b",
  gemini: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
};

/**
 * Whether to send Gemini an explicit thinking budget, and what it should be.
 * `null` omits `thinkingConfig` entirely.
 *
 * This is model-dependent and there is no safe universal value — measured:
 *   gemini-3.5-flash-lite  REJECTS thinkingConfig with 400 invalid argument
 *   gemini-2.5-flash       REQUIRES thinkingBudget: 0, or 111 thinking tokens
 *                          eat the 120-token cap and the response comes back
 *                          finishReason MAX_TOKENS with the text "Living here,
 *                          you would" — a truncated fragment, not an error
 *
 * Default is `null` because the default model is 3.5-flash-lite. Set
 * GEMINI_THINKING_BUDGET=0 when pointing at a 2.5 model. The adapter also
 * retries without the field on a 400, so a model swap degrades rather than breaks.
 */
export const GEMINI_THINKING_BUDGET =
  process.env.GEMINI_THINKING_BUDGET === undefined
    ? null
    : Number(process.env.GEMINI_THINKING_BUDGET);

export const OLLAMA_ENDPOINT =
  process.env.OLLAMA_ENDPOINT || "http://localhost:11434/api/generate";

export const GEMINI_ENDPOINT_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

/** Consistency over creativity — two lookups of the same block should read alike. */
export const AI_TEMPERATURE = 0.3;

/**
 * Output cap. Gemini counts thinking tokens against this, see gemini.js.
 *
 * Sized for the ~120-word target in prompt.js's buildOverallSummaryPrompt()
 * (and comfortably covers the shorter 1-2 sentence per-section prompts too).
 * English prose runs roughly 1.3-1.5 tokens per word, so 120 words needs
 * ~155-180 tokens; 180 leaves headroom for the model to slightly overshoot
 * the word target without truncating mid-sentence.
 */
export const AI_MAX_OUTPUT_TOKENS = 180;

/**
 * Per-call timeouts. Ollama on CPU is genuinely slow (8B model, tens of
 * seconds), and this call is on its own request budget by design — but it still
 * needs a ceiling, or a wedged local model hangs the tab forever.
 */
export const AI_TIMEOUT_MS = {
  ollama: 45000,
  gemini: 12000,
};

/** Explanations must be short enough to sit under a score without wrapping forever. */
export const EXPLANATION_MAX_CHARS = 400;

/** Where an explanation came from. Mirrors `explanationSource` in the API. */
export const EXPLANATION_SOURCES = {
  ai: "ai",
  template: "template",
};

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export const NYC_BOUNDS = {
  minLat: 40.4,
  maxLat: 40.95,
  minLng: -74.3,
  maxLng: -73.7,
};

// ---------------------------------------------------------------------------
// Amenity data sources — CONFIRMED against live APIs 2026-08-29
// ---------------------------------------------------------------------------
//
// Static-dataset sources for the amenity scores (transit/parks/bike). Unlike
// SOCRATA_DATASET_ID above, these are NOT all on data.cityofnewyork.us and NOT
// all Socrata — recorded here, confirmed, so scripts/verifyAmenities.js and
// scripts/buildAmenities.js share one source of truth instead of re-guessing.
//
// Subway entrances and the combined LIRR/Metro-North rail stations both live
// on data.ny.gov (the STATE catalog), not data.cityofnewyork.us — the initial
// assumption they'd be on the city catalog was wrong; verified via Socrata's
// own catalog search API. Bus stops have no Socrata dataset at all: the only
// source is MTA's per-borough GTFS static feed (5 separate zips, no combined
// file), confirmed live (all 5 resolve 200, Bronx alone yields 1,884 stops in
// stops.txt). Citi Bike GBFS and the two Socrata NYC datasets (parks, bike
// routes) matched the original guess exactly.

export const AMENITY_SOURCES = {
  // The entrances dataset carries the COMPLEX-level truth directly on every
  // row — complex_id (the official MTA grouping riders think of as "one
  // station"), and daytime_routes already scoped to that whole complex (e.g.
  // every Herald Sq entrance reads "B D F M N Q R W", not just its nearest
  // platform's lines). scripts/buildAmenities.js used to join this dataset
  // against a SEPARATE stations dataset by 250m proximity just to get routes;
  // that join is gone — see CLAUDE.md's complex-clustering note for why
  // reading daytime_routes straight off each row is both simpler and more
  // correct (down to a documented complex_id data bug the old join couldn't
  // have caught either).
  subway: {
    kind: "socrata",
    domain: "data.ny.gov",
    datasetId: "i9wp-a4ja", // "MTA Subway Entrances and Exits: 2024" — 2,120 rows
    latField: "entrance_latitude",
    lngField: "entrance_longitude",
    nameField: "stop_name",
    complexIdField: "complex_id",
    routesField: "daytime_routes", // space-separated, e.g. "B D F M N Q R W"
  },
  rail: {
    kind: "socrata",
    domain: "data.ny.gov",
    // "MTA Rail Stations" — LIRR + Metro-North in ONE dataset, 238 rows
    // (126 LIRR + 112 MNR). Simpler than the two-source guess in the original
    // plan — no need to fetch LIRR and MNR separately.
    datasetId: "wxmd-5cpm",
    latField: "latitude",
    lngField: "longitude",
    nameField: "station_name",
    railroadField: "railroad", // "LIRR" | "MNR"
  },
  bus: {
    kind: "gtfs-zip",
    // No combined feed — one zip per borough, each redirecting to an S3-hosted
    // stops.txt. Row counts are summed across all five when building.
    urls: [
      "http://web.mta.info/developers/data/nyct/bus/google_transit_bronx.zip",
      "http://web.mta.info/developers/data/nyct/bus/google_transit_brooklyn.zip",
      "http://web.mta.info/developers/data/nyct/bus/google_transit_manhattan.zip",
      "http://web.mta.info/developers/data/nyct/bus/google_transit_queens.zip",
      "http://web.mta.info/developers/data/nyct/bus/google_transit_staten_island.zip",
    ],
  },
  parks: {
    kind: "socrata",
    domain: "data.cityofnewyork.us",
    datasetId: "enfh-gkve", // "Parks Properties" — 2,064 rows
    geometryField: "multipolygon", // MultiPolygon, NOT a simple Polygon
    typeField: "typecategory", // splits into park / playground / garden
    nameField: "signname",
  },
  bikeShare: {
    kind: "gbfs",
    url: "https://gbfs.citibikenyc.com/gbfs/en/station_information.json",
  },
  bikeLane: {
    kind: "socrata",
    domain: "data.cityofnewyork.us",
    datasetId: "mzxg-pwib", // "New York City Bike Routes" — 29,695 rows
    geometryField: "the_geom", // MultiLineString, NOT a simple LineString
    // facilitycl "I" (protected/sidewalk/boardwalk paths) -> protectedLane;
    // "II"/"III" (conventional/curbside/shared/signed routes) -> bikeLane.
    // "L" (Link, 475 rows) is excluded — a connector segment, not a route.
    classField: "facilitycl",
    protectedClasses: ["I"],
    laneClasses: ["II", "III"],
  },
};

/**
 * Maps a `typecategory` value from the Parks Properties dataset onto one of
 * the three park buckets. Not a 1:1 rename — 19 distinct values exist (see
 * CLAUDE.md), and several map to the same bucket. Anything unmapped falls
 * into `park` rather than being silently dropped, since every one of these is
 * still Parks Dept property someone could walk to.
 */
export const PARKS_TYPECATEGORY_TO_BUCKET = {
  Playground: "playground",
  "Jointly Operated Playground": "playground",
  Garden: "garden",
  "Nature Area": "garden",
};

// ---------------------------------------------------------------------------
// Amenity tiers — static-dataset scores, distance rather than count
// ---------------------------------------------------------------------------
//
// Deliberately NOT part of RADIUS_TIERS — see the "Amenity Scores" section of
// CLAUDE.md for why mixing a static tier into that Socrata-coupled structure
// would be a hazard, not a convenience.

export const AMENITY_TIERS = {
  transit: {
    tier: "transit",
    radiusMeters: 800, // ~10 min walk, the standard transit walkshed
    dataset: "transit",
    buckets: ["subway", "bus", "rail"],
  },
  parks: {
    tier: "parks",
    radiusMeters: 800,
    dataset: "parks",
    buckets: ["park", "playground", "garden"],
  },
  bike: {
    tier: "bike",
    radiusMeters: 800,
    dataset: "bike",
    buckets: ["bikeShare", "bikeLane", "protectedLane"],
  },
  // No `dataset` field — unlike the three above, walkability has no
  // committed static dataset behind it. amenityService.js's getAmenityMetrics()
  // loop keys off `dataset` to find a preloaded spatial index; the absence of
  // one here makes that loop skip this tier by construction (datasets?.[undefined]
  // is undefined), rather than needing an explicit exclusion list. It is scored
  // by a SEPARATE function, getWalkabilityMetrics(), backed by a live Google
  // Places lookup — see the "Walkability" section of CLAUDE.md.
  walkability: {
    tier: "walkability",
    radiusMeters: 800,
    buckets: ["grocery", "restaurant", "cafe", "school"],
  },
};

/** Bucket names in a stable order, per amenity tier — mirrors BUCKET_NAMES. */
export const AMENITY_BUCKET_NAMES = Object.fromEntries(
  Object.entries(AMENITY_TIERS).map(([tier, { buckets }]) => [tier, buckets])
);

/**
 * Past this, "the nearest one" stops being a fact about this address and
 * starts being a fact about the city. Scored as the cap and flagged
 * low-confidence per bucket rather than reported as a distance nobody would
 * walk.
 */
export const AMENITY_MAX_METERS = 2000;

/**
 * Grid cell size for the amenity nearest-neighbour index, in degrees.
 * ~0.005 deg ~= 450m at NYC's latitude — the same rounding-idiom scale the
 * complaint cache already uses for its coordinate key (CACHE_COORD_PRECISION).
 */
export const AMENITY_GRID_DEGREES = 0.005;

/**
 * Bike-lane LineStrings are resampled to a point every this many metres.
 *
 * 25m was the original estimate (~48k densified points, ~1.2MB committed).
 * MEASURED against the real dataset (29,695 segments, mostly short city
 * blocks): 25m spacing produced 136,666 points and a 3.3MB file — segments
 * are shorter and more numerous than estimated. 40m keeps the accuracy cost
 * (+/-20m, invisible at the resolution anyone acts on) but brings the point
 * count and file size down substantially — see scripts/buildAmenities.js.
 */
export const AMENITY_LANE_SPACING_METERS = 40;

/**
 * Buckets whose points are a resampled bike-route LINE (one point every
 * AMENITY_LANE_SPACING_METERS), not discrete real-world instances.
 *
 * GET /api/amenities/nearby (the "every instance within radius" browser
 * behind an amenity row's `>` affordance) excludes these two outright: "all
 * instances within 800m" for a resampled line would return dozens of
 * ~40m-spaced points along the SAME lane, not a list of distinct places, and
 * silently returning that point cloud would read as a data bug rather than
 * the deliberate exclusion it is.
 */
export const NON_DISCRETE_AMENITY_BUCKETS = ["bikeLane", "protectedLane"];

/** ~4.8 km/h — used to render a distance as an estimated walk time. */
export const AMENITY_WALK_METERS_PER_MIN = 80;

export const AMENITY_BASELINE_COLLECTION = "amenity_baseline";
export const AMENITIES_COLLECTION = "amenity_datasets";
export const AMENITY_BASELINE_ID = "v1";

/** Sample size for scripts/buildAmenityBaseline.js. Smaller than the 311
 * baseline's 250 is fine here — the sampled quantity (distance) is far less
 * noisy than a complaint count, so it converges with fewer points. */
export const AMENITY_BASELINE_SAMPLE_SIZE = 150;

/**
 * Independent from BASELINE_SAMPLE_SEED — this script threads its OWN
 * seededRandom() instance through scripts/lib/sampleCoords.js, so its draws
 * never interleave with buildBaseline.js's. Deterministic within itself: a
 * rerun samples the same coordinates.
 */
export const AMENITY_BASELINE_SAMPLE_SEED = 20260829;

/**
 * buildAmenityBaseline.js measures each sampled point with a LIVE Google
 * Routes call (see amenityService.js's getAmenityMetrics `routeRetries`
 * doc) — unlike the request path's fail-fast default of 0 retries, this
 * script's ~150 sequential calls are worth retrying on a transient 429/5xx
 * rather than letting that one sample point silently fall back to
 * straight-line. `AMENITY_BASELINE_ROUTE_PACING_MS` is a fixed delay
 * between points on top of that, to keep the steady-state request rate
 * under Google's per-second quota in the first place — retries alone only
 * react after the quota is already tripped.
 */
export const AMENITY_BASELINE_ROUTE_RETRIES = 3;
export const AMENITY_BASELINE_ROUTE_PACING_MS = 250;

/**
 * Weighted mean weights for the amenity buckets. Separate from BUCKET_WEIGHTS
 * so the existing test/constants.test.js assertion (weights = flattened
 * BUCKET_NAMES) keeps passing untouched. Subway weighted 2x because for most
 * New Yorkers it is the deciding transit factor — an explicit, editable
 * judgement here rather than one smuggled in by padding a bucket list (see
 * CLAUDE.md decision 6 on BUCKET_WEIGHTS).
 */
export const AMENITY_WEIGHTS = {
  subway: 2,
  bus: 1,
  rail: 1,
  park: 1,
  playground: 1,
  garden: 1,
  bikeShare: 1,
  bikeLane: 1,
  protectedLane: 1,
  // Grocery weighted 2x for the same reason subway is: Walk Score's own
  // methodology treats food access as the single most decisive walkability
  // factor, and a block with three cafes but no grocery store is not
  // "average" walkable, it is missing the errand that matters most.
  grocery: 2,
  restaurant: 1,
  cafe: 1,
  school: 1,
};

/**
 * How many straight-line-nearest candidates per bucket get sent to Google's
 * Routes API for real walking distance. Not 1: the straight-line-nearest
 * point is not always the walking-nearest one (a park across a highway with
 * no crossing scores as adjacent by air, farther by foot) — sending the top 3
 * and keeping whichever comes back with the shortest real distance catches
 * that without needing point-to-segment street-network math of our own.
 */
export const AMENITY_ROUTE_CANDIDATES = 3;

/**
 * computeRouteMatrix is one HTTP call for the whole batch (all buckets, all
 * candidates), not one per candidate — that batching is what keeps this
 * feature's cost and latency bounded to ONE extra request per score, same
 * order of magnitude as the Socrata call already on this path.
 */
export const GOOGLE_ROUTES_MATRIX_URL =
  "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

/**
 * Tight because, unlike the AI explanation call, this one IS on the score
 * request's critical path (run inside the same Promise.all as the complaint
 * counts). A slow or hanging Routes API must not make /api/score itself
 * hang — it degrades to the straight-line distance already in hand instead.
 */
export const GOOGLE_ROUTES_TIMEOUT_MS = 4000;

/**
 * Real walking distances are cached per rounded coordinate — unlike the
 * straight-line grid lookup this replaces, a Google Routes call costs money
 * and network time, so repeat views of the same address (a refresh, the
 * explanation fetch, a compare page) must not re-bill it. Reuses the
 * complaint cache's collection/TTL/rounding rather than standing up a new
 * one — see providers/cache.js.
 */
export const AMENITY_DISTANCE_CACHE_RADIUS_TIER = "amenityDistances";

/**
 * Bus stops within this distance of each other are treated as one physical
 * pole — e.g. the M1/M2/M3/M4 each get their own GTFS stop record even when
 * they all board from the same corner — and merged into one point with a
 * unioned, sorted route list at build time (scripts/buildAmenities.js's
 * buildBusBucket). Small on purpose: this is "same curb," not "same
 * intersection" — two stops on opposite corners of a wide avenue are still
 * genuinely different places to stand.
 */
export const BUS_STOP_CLUSTER_RADIUS_METERS = 10;

/**
 * How many distinct subway complexes / bus stops GET /api/amenities/nearby
 * returns for these two buckets, closest first, AFTER the same-line dedup in
 * amenityService.js's getNearbyAmenityInstances — not a raw entrance/point
 * cap. A dense transfer hub can have 50+ raw subway entrances or a dozen
 * overlapping bus routes within 800m; once entrances are grouped into
 * complexes and bus stops into poles (see BUS_STOP_CLUSTER_RADIUS_METERS
 * above), the count that matters to a renter is "how many distinct places
 * could I catch a train/bus," which stays small even at the densest hubs.
 * Every other amenity bucket (rail, parks, bike, walkability) has no such
 * density problem and is unaffected by either constant.
 */
export const AMENITY_SUBWAY_COMPLEX_CAP = 5;
export const AMENITY_BUS_STOP_CAP = 5;

// ---------------------------------------------------------------------------
// Walkability — live Google Places lookup, NOT a static dataset
// ---------------------------------------------------------------------------
//
// Unlike transit/parks/bike, there is no free, slow-changing public dataset
// for "grocery stores, restaurants, cafes, and schools in NYC" — that only
// exists behind a billed API. Rather than a one-time citywide sweep (a large
// upfront Places bill before this ships at all), this tier calls Places
// Nearby Search live, per report, and caches the raw result per coordinate
// so a repeat view of the same area never re-bills it. See CLAUDE.md.

/**
 * Google's `includedTypes` values for Nearby Search (Places API, New),
 * mapped onto our four buckets. Several Google types collapse onto one
 * bucket (three school levels -> one "school" bucket) — a place's `types`
 * array is checked against this map in order, first match wins.
 */
export const WALKABILITY_TYPE_TO_BUCKET = {
  grocery_store: "grocery",
  supermarket: "grocery",
  restaurant: "restaurant",
  cafe: "cafe",
  school: "school",
  primary_school: "school",
  secondary_school: "school",
};

/**
 * ONE Nearby Search call requests every type at once and Google returns them
 * interleaved, ranked by distance — bucketing happens after the fact by
 * inspecting each result's own `types`. This is what keeps the feature to
 * one billed call per (new) coordinate rather than one per bucket (4x cost).
 *
 * The tradeoff: with `maxResultCount` capped at 20, a location with many
 * restaurants nearby could theoretically crowd out a farther-but-still-
 * in-range grocery store from the top 20 closest-of-any-type results. Judged
 * acceptable for NYC's density (20 results within an 800m circle rarely miss
 * a real category entirely) rather than paying for a second call to rule it
 * out.
 */
export const WALKABILITY_MAX_RESULTS = 20;

export const GOOGLE_PLACES_NEARBY_URL =
  "https://places.googleapis.com/v1/places:searchNearby";

/**
 * On the request's critical path exactly like GOOGLE_ROUTES_TIMEOUT_MS, and
 * for the same reason: a slow or hanging Places call must not make
 * /api/score itself hang. Degrades to "walkability section omitted" — see
 * getWalkabilityMetrics().
 */
export const GOOGLE_PLACES_TIMEOUT_MS = 4000;

/**
 * Coordinates are rounded to this many decimals for the walkability cache
 * key — coarser than CACHE_COORD_PRECISION's 4dp (~11m). This cache exists
 * specifically to avoid re-billing a Places call, so it deliberately trades
 * precision for a much higher hit rate: 3dp is ~111m at NYC's latitude, wide
 * enough that most addresses on the same block share a cache entry.
 */
export const WALKABILITY_CACHE_PRECISION = 3;

export const WALKABILITY_CACHE_COLLECTION = "walkability_cache";

/**
 * 30 days, not the 24h every other cache here uses. Grocery stores,
 * restaurants and schools change on a timescale of months, not days —
 * 311 complaint volume does not. A dedicated collection (rather than
 * CACHE_COLLECTION) exists only so this can have its own TTL index; Mongo
 * ties expireAfterSeconds to the collection's index, not to the document.
 */
export const WALKABILITY_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Reasoned estimates, NOT sampled from real NYC data. Building a real
 * baseline the way scripts/buildAmenityBaseline.js does for the other three
 * tiers would mean running AMENITY_BASELINE_SAMPLE_SIZE (150) live, billed
 * Places lookups up front — exactly the up-front cost this tier's
 * live-and-cached design was chosen to avoid. These medians/p90s are
 * order-of-magnitude judgements for a dense NYC block (a grocery store
 * within ~200m is unremarkable; one within ~600-1000m is genuinely sparse),
 * good enough to make "closer scores better" behave sensibly while this
 * ships. Replace with a sampled baseline (see AMENITY_BASELINE_SAMPLE_SIZE)
 * once the cost of doing so is acceptable — flagged, not hidden.
 */
export const WALKABILITY_BASELINE_PER_BUCKET = {
  grocery: { median: 200, p90: 600 },
  restaurant: { median: 120, p90: 400 },
  cafe: { median: 150, p90: 450 },
  school: { median: 350, p90: 800 },
};
