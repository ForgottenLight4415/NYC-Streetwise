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

/** Short output cap. Gemini counts thinking tokens against this, see gemini.js. */
export const AI_MAX_OUTPUT_TOKENS = 120;

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
