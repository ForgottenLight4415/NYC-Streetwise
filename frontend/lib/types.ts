export type ScoreBand = "good" | "fair" | "poor";
export type Confidence = "normal" | "low";

export type ComplaintStatus = "open" | "in-progress" | "closed";

export interface Complaint {
  id: string;
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

export interface TimelineEvent {
  status: ComplaintStatus;
  date: string; // YYYY-MM-DD
  note?: string;
}

export interface ComplaintTimeline {
  complaintId: string;
  events: TimelineEvent[];
}
