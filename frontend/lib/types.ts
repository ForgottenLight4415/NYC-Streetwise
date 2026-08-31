/** The two complaint tiers (Building Health, Block Quality). */
export type ComplaintBand = "good" | "fair" | "poor";

/**
 * The four amenity tiers (transit/parks/bike/walkability). A separate
 * vocabulary from ComplaintBand, not the same three words at different
 * cutoffs: an amenity score is a citywide PERCENTILE distance, and NYC is
 * transit-dense enough that "typical" is already a fine outcome — labeling
 * it "fair" (a complaint-scale word implying "mediocre, keep looking") would
 * misdescribe it. See AMENITY_BAND_THRESHOLDS in the backend's constants.js.
 */
export type AmenityBand = "carDependent" | "typical" | "excellent";

export type ScoreBand = ComplaintBand | AmenityBand;
export type Confidence = "normal" | "low";

export type ComplaintStatus = "open" | "in-progress" | "closed";

export interface Complaint {
  /** React key. The 311 unique_key when we have one, else a synthetic fallback. */
  id: string;
  /**
   * The dataset's own primary key — the number a renter could quote to 311.
   *
   * Optional, and only ever set from real data: mock complaints leave it unset
   * so nothing invented is displayed as a case number. The UI must therefore
   * treat "absent" as "show nothing", never as "fall back to `id`" — `id` can
   * be our own synthetic string, which is what used to be shown as a
   * "Complaint #" while being an artifact of pagination.
   */
  referenceId?: string;
  label: string;
  date: string; // YYYY-MM-DD
  status: ComplaintStatus;
}

export type BuildingCounts = {
  heatHotWater: number;
  unsanitaryCondition: number;
  plumbing: number;
};

export type BlockCounts = {
  noise: number;
  parking: number;
  streetCondition: number;
};

export type ExplanationSource = "ai" | "template";

/**
 * Field-for-field what every scored section has, complaint or amenity —
 * extracted so both `ScoreSection` and `AmenitySection` stay in lockstep
 * without either one growing fields the other doesn't need.
 *
 * `explanation`/`explanationSource` are OPTIONAL here, not required: the
 * backend attaches a deterministic template inline only for the two
 * complaint tiers (`ScoreSection` below requires them). An amenity section
 * never carries them in `/api/score`'s response — its explanation is always
 * fetched fresh via `GET /api/explanation` — so `AmenitySection` inherits
 * them as absent rather than lying about a field that isn't there.
 */
export interface SectionBase {
  score: number;
  band: ScoreBand;
  radiusMeters: number;
  explanation?: string;
  explanationSource?: ExplanationSource;
  confidence: Confidence;
  confidenceReason: string | null;
}

export interface ScoreSection<TCounts extends Record<string, number>>
  extends SectionBase {
  // Narrows SectionBase's `band: ScoreBand` — a complaint tier only ever
  // produces a ComplaintBand.
  band: ComplaintBand;
  // /api/score always returns the deterministic template text so it can stay
  // fast; a tier only reports "ai" once GET /api/explanation has been called
  // for it and the result cached server-side.
  explanation: string;
  explanationSource: ExplanationSource;
  counts: TCounts;
  bucketScores: Partial<Record<keyof TCounts, number>>;
  bucketConfidence: Partial<Record<keyof TCounts, "low">>;
  /**
   * Per-category status breakdown (open/in-progress/closed), computed
   * server-side from the SAME Socrata query `counts` already comes from —
   * see the `bucketStatusCounts` CONTRACT CHANGE note in the backend's
   * CLAUDE.md. Each category's triple sums back to that category's own
   * `counts` value.
   *
   * OPTIONAL, and genuinely absent rather than zero-filled: a `complaint_cache`
   * document written before this field shipped has none (self-heals within
   * the 24h TTL), and so does a hand-built payload that predates it. The
   * client must fall back to a plain count when this is missing, never invent
   * or infer a breakdown client-side — see ComplaintBreakdownBars.
   */
  bucketStatusCounts?: Partial<Record<keyof TCounts, Record<ComplaintStatus, number>>>;
  recentComplaints?: Complaint[];
}

/** Distance-and-count metrics for one amenity bucket, e.g. `transit.subway`. */
export interface AmenityMetric {
  /** Metres to the nearest one. Null means nothing inside the cap — a real
   *  answer for much of Staten Island, not a fetch failure. */
  meters: number | null;
  /** How many inside radiusMeters. DISPLAY ONLY — never scored, because three
   *  bus stops on one corner is not three times the access. */
  within: number;
  /** e.g. "14 St-Union Sq". Null when the dataset had no name. */
  name: string | null;
  /**
   * **CONTRACT CHANGE (post-freeze): routes added to the transit
   * AmenityMetric. Flag to Person 2.** Which subway/bus routes serve this
   * stop, e.g. `["4", "5", "6"]` or `["M104"]`. Present ONLY on
   * `transit.subway` and `transit.bus` — deliberately ABSENT (not `[]`) on
   * every other bucket, including `transit.rail` (no route-join source; out
   * of scope) and every parks/bike/walkability bucket (no route concept at
   * all). See `getAmenityMetrics` in the backend's `amenityService.js`,
   * which only ever sets this key for those two buckets. Any consumer must
   * check the bucket (or use `?.`) before reading this — do not assume it is
   * always an array.
   */
  routes?: string[];
}

export interface AmenitySection<TMetrics extends Record<string, AmenityMetric>>
  extends SectionBase {
  // Narrows SectionBase's `band: ScoreBand` — an amenity tier only ever
  // produces an AmenityBand.
  band: AmenityBand;
  metrics: TMetrics;
  bucketScores: Partial<Record<keyof TMetrics, number>>;
  bucketConfidence: Partial<Record<keyof TMetrics, "low">>;
}

export type TransitMetrics = { subway: AmenityMetric; bus: AmenityMetric; rail: AmenityMetric };
export type ParksMetrics = { park: AmenityMetric; playground: AmenityMetric; garden: AmenityMetric };
export type BikeMetrics = { bikeShare: AmenityMetric; bikeLane: AmenityMetric; protectedLane: AmenityMetric };
export type WalkabilityMetrics = {
  grocery: AmenityMetric;
  restaurant: AmenityMetric;
  cafe: AmenityMetric;
  school: AmenityMetric;
};

export interface ReportMeta {
  windowMonths: number;
  baselineVersion: string;
  baselineSource: "mongo" | "file" | "mock";
  coord: { lat: number; lng: number };
  mock?: boolean;
}

/**
 * The whole-report summary — under 100 words, selective across every section
 * rather than one sentence per section. Same explanation/explanationSource
 * shape as SectionBase's pair, deliberately: the frontend fetches its real
 * text via the same GET /api/explanation?tier=overall two-call pattern.
 */
export interface ReportSummary {
  explanation: string;
  explanationSource: ExplanationSource;
}

export interface ReportResponse {
  address: string | null;
  summary: ReportSummary;
  buildingHealth: ScoreSection<BuildingCounts>;
  blockQuality: ScoreSection<BlockCounts>;
  // Optional: /api/showcase can serve a Mongo-cached document that predates
  // this feature, and a report degrades to these two sections whenever the
  // amenity datasets fail to load server-side.
  transitAccess?: AmenitySection<TransitMetrics>;
  parksAccess?: AmenitySection<ParksMetrics>;
  bikeAccess?: AmenitySection<BikeMetrics>;
  // Live-Places-backed, unlike the three above — see backend CLAUDE.md's
  // Walkability section. Optional for the same reasons: a pre-rollout
  // showcase cache, or (its own, independent failure mode) a cache-only
  // render path that never called Places at all.
  walkabilityAccess?: AmenitySection<WalkabilityMetrics>;
  meta: ReportMeta;
}

/** Field names on ReportResponse. */
export type CategoryKey =
  | "buildingHealth"
  | "blockQuality"
  | "transitAccess"
  | "parksAccess"
  | "bikeAccess"
  | "walkabilityAccess";

/**
 * The `?tier=` wire value. Separate axis — the API already says "building".
 * "overall" has no matching CategoryKey — it is not one report section, it
 * summarizes across all of them (ReportResponse.summary, not report[key]).
 */
export type CategoryId =
  | "building"
  | "block"
  | "transit"
  | "parks"
  | "bike"
  | "walkability"
  | "overall";

/** The two complaint tiers — the only ones with a complaint feed or trend. */
export type ComplaintTierId = "building" | "block";

/**
 * One address the backend has both a name and cached scores for.
 *
 * Extends ReportResponse rather than wrapping it because that is literally what
 * /api/showcase returns — the score payload with the address grafted on. The
 * `address` field is non-null here, unlike on ReportResponse, which is the whole
 * reason this type exists: /api/score is coordinate-only and answers `null`, and
 * only the lookup directory knows what a coordinate is called.
 */
export interface ShowcaseItem extends Omit<ReportResponse, "address"> {
  address: string;
  borough: string | null;
  lat: number;
  lng: number;
  lookups: number;
  lastSeenAt: string | null;
  /** True for the committed pre-warmed set, false for a real visitor lookup. */
  curated: boolean;
}

/**
 * A named address with no scores — what the homepage's hero card falls back to
 * when nothing is cached, and fetches a live score for itself.
 *
 * Comes from the backend's committed curated list, picked at random per request,
 * so the frontend does not keep its own copy of addresses and coordinates that
 * could drift from the set actually being pre-warmed.
 */
export interface ShowcaseFallback {
  address: string;
  borough: string | null;
  lat: number;
  lng: number;
}

export interface AutocompleteSuggestion {
  id: string;
  description: string;
}

export interface TrendPoint {
  month: string; // "2026-08"
  count: number;
}

/**
 * One real instance behind an amenity row's `>` affordance — the full list
 * GET /api/amenities/nearby returns for one bucket, as opposed to just the
 * single nearest one AmenityMetric carries for scoring.
 */
export interface AmenityInstance {
  name: string | null;
  meters: number;
  lat: number;
  lng: number;
  /** Only present on transit's subway/bus instances — same route-list
   *  concept as AmenityMetric.routes. Absent (not `[]`) on every other
   *  bucket, since those have no route concept at all. */
  routes?: string[];
}

/**
 * GET /api/amenities/nearby's response shape.
 *
 * `truncated` is true when the real count inside `radiusMeters` exceeds the
 * backend's own cap (50) — the response still lists the closest ones, just
 * not all of them.
 */
export interface AmenityNearbyResponse {
  instances: AmenityInstance[];
  radiusMeters: number;
  truncated: boolean;
}

/**
 * One day's complaints of a single type, as the complaints browser lists them.
 *
 * Grouped server-side, which is the only way the densest addresses are
 * listable at all — one Bronx address has 190,205 raw complaints in the
 * 24-month window but only 1,848 of these.
 */
export interface ComplaintGroup {
  day: string; // YYYY-MM-DD
  type: string;
  counts: Record<ComplaintStatus, number>;
  total: number;
}

/** A page of results plus what the caller needs to page through the rest. */
export interface ComplaintPage<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  truncated: boolean;
}

// TimelineEvent / ComplaintTimeline lived here. Removed with the "progress
// timeline" they described: 311 publishes a complaint's CURRENT status and no
// change log, so every intermediate event was synthesised client-side — and for
// anything filed recently it synthesised dates in the future. The detail modal
// now shows the filing date and the current status, which is all there is.
