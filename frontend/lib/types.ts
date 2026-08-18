export type ScoreBand = "good" | "fair" | "poor";
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

export interface ScoreSection<TCounts extends Record<string, number>> {
  score: number;
  band: ScoreBand;
  counts: TCounts;
  radiusMeters: number;
  // /api/score always returns the deterministic template text so it can stay
  // fast; a tier only reports "ai" once GET /api/explanation has been called
  // for it and the result cached server-side.
  explanation: string;
  explanationSource: ExplanationSource;
  confidence: Confidence;
  confidenceReason: string | null;
  bucketScores: Partial<Record<keyof TCounts, number>>;
  bucketConfidence: Partial<Record<keyof TCounts, "low">>;
  recentComplaints?: Complaint[];
}

export interface ReportMeta {
  windowMonths: number;
  baselineVersion: string;
  baselineSource: "mongo" | "file" | "mock";
  coord: { lat: number; lng: number };
  cache: { building: "hit" | "miss"; block: "hit" | "miss" };
  mock?: boolean;
}

export interface ReportResponse {
  address: string | null;
  buildingHealth: ScoreSection<BuildingCounts>;
  blockQuality: ScoreSection<BlockCounts>;
  meta: ReportMeta;
}

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
