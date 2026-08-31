import { AMENITY_CATEGORIES, COMPLAINT_CATEGORIES } from "./categories";
import { AMENITY_BUCKET_LABEL, formatWalk, nearestMetric } from "./amenities";
import { meanScore, overallAmenityBand, overallBand } from "./score";
import type { AmenityBand, ComplaintBand, ReportResponse, TrendPoint } from "./types";

/** "YYYY-MM-DD" for `months` months ago, for comparing against Complaint.date. */
export function monthsAgoISO(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * The last `months` entries of a 24-month, oldest-first series — every window
 * is a suffix of the widest one, so this is the one slice every window reads
 * from. Mirrors the inline slice TrendSection used to own.
 */
export function sliceWindow(
  points: TrendPoint[] | undefined,
  months: number,
): TrendPoint[] | null {
  return points && points.length > 0 ? points.slice(-months) : null;
}

/** Sum of one already-sliced window. */
export function windowTotal(points: TrendPoint[] | null): number | null {
  return points ? points.reduce((sum, p) => sum + p.count, 0) : null;
}

/**
 * Year-over-year change: the most recent 12 months against the 12 before
 * them. `null` unless the full 24-month series is in hand — a partial
 * comparison (say, 9 months vs. a padded prior period) would misstate the
 * direction, not just the magnitude.
 *
 * Polarity is inverted from the usual "green means up" convention: these are
 * complaint counts, so a NEGATIVE pct is the good outcome. Callers must map
 * `pct < 0` to `--status-good-ink`, not the reverse.
 */
export function yoyDelta(
  points: TrendPoint[] | undefined,
): { current: number; prior: number; pct: number | null } | null {
  if (!points || points.length < 24) return null;
  const last24 = points.slice(-24);
  const prior = last24.slice(0, 12).reduce((sum, p) => sum + p.count, 0);
  const current = last24.slice(12).reduce((sum, p) => sum + p.count, 0);
  const pct = prior === 0 ? null : ((current - prior) / prior) * 100;
  return { current, prior, pct };
}

export interface OverviewMetrics {
  liveabilityBand: ComplaintBand;
  liveabilityScore: number;
  hasAccess: boolean;
  accessBand: AmenityBand;
  accessScore: number | null;
  /** Nearest-transit summary — shared by VerdictBanner's headline computation
   *  needs nothing here, but OverviewHeader's "Nearest Transit" tile does.
   *  `transitBucket` is recorded for subway/bus/rail alike (unlike the old
   *  inline version in VerdictBanner, which only tracked it for the two
   *  route-badge buckets) so the tile can always show a type label. */
  transitWalk: string | null;
  transitName: string | null;
  transitBucket: string | null;
  /** Only ever non-empty for transitBucket "subway"/"bus" — see AmenityMetric.routes. */
  transitRoutes: string[];
}

/**
 * Pure derivation from one `ReportResponse` — the score/band/nearest-transit
 * numbers both VerdictBanner (headline) and OverviewHeader (KPI tiles) need.
 * No hooks: everything here is a synchronous fold over data already in hand,
 * so both components call this directly during render instead of duplicating
 * the fold inline (which is how this drifted before — see the "Nearest
 * subway"/"Nearest Transit" split this replaces).
 */
export function computeOverviewMetrics(report: ReportResponse): OverviewMetrics {
  const complaintSections = COMPLAINT_CATEGORIES.map((c) => report[c.key]);
  const liveabilityBand = overallBand(...complaintSections.map((s) => s.band));
  const liveabilityScore = meanScore(
    report.buildingHealth.score,
    report.blockQuality.score,
  );

  const amenityCats = AMENITY_CATEGORIES.filter((c) => report[c.key] != null);
  const hasAccess = amenityCats.length > 0;
  const amenitySections = amenityCats.map((c) => report[c.key]!);
  const accessBand = hasAccess
    ? overallAmenityBand(...amenitySections.map((s) => s.band))
    : "excellent";
  const accessScore = hasAccess
    ? meanScore(...amenitySections.map((s) => s.score))
    : null;

  const transit = report.transitAccess;
  let transitWalk: string | null = null;
  let transitName: string | null = null;
  let transitBucket: string | null = null;
  let transitRoutes: string[] = [];
  if (transit) {
    const subway = transit.metrics.subway;
    if (subway.meters !== null) {
      transitWalk = formatWalk(subway.meters);
      transitName = subway.name ?? AMENITY_BUCKET_LABEL.subway;
      transitBucket = "subway";
      transitRoutes = subway.routes ?? [];
    } else {
      const nearest = nearestMetric(transit.metrics);
      if (nearest) {
        transitWalk = formatWalk(nearest.metric.meters);
        transitName =
          nearest.metric.name ??
          AMENITY_BUCKET_LABEL[nearest.bucket as string] ??
          "nearby";
        transitBucket = nearest.bucket as string;
        if (nearest.bucket === "subway" || nearest.bucket === "bus") {
          transitRoutes = nearest.metric.routes ?? [];
        }
      }
    }
  }

  return {
    liveabilityBand,
    liveabilityScore,
    hasAccess,
    accessBand,
    accessScore,
    transitWalk,
    transitName,
    transitBucket,
    transitRoutes,
  };
}
