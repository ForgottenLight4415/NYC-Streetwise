import { AMENITY_BUCKET_LABEL, formatWalk, nearestMetric } from "./amenities";
import { CITYWIDE_BASELINE } from "./citywide-baseline";
import type {
  AmenityBand,
  AmenityMetric,
  AmenitySection,
  BlockCounts,
  BuildingCounts,
  ComplaintBand,
  ComplaintStatus,
  ScoreBand,
  ScoreSection,
} from "./types";

export function bandForScore(score: number): ComplaintBand {
  if (score >= 70) return "good";
  if (score >= 40) return "fair";
  return "poor";
}

/** Generic across both vocabularies — every StatusBadge/ScoreMeter/PanelShell
 *  looks a band up here regardless of whether it's a complaint or amenity one. */
export const BAND_LABEL: Record<ScoreBand, string> = {
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  excellent: "Excellent",
  typical: "Good",
  carDependent: "Car Dependent",
};

/** Generic across both vocabularies — same reasoning as BAND_LABEL above. */
export const BAND_VAR: Record<ScoreBand, string> = {
  good: "--status-good",
  fair: "--status-warning",
  poor: "--status-critical",
  excellent: "--status-good",
  typical: "--status-warning",
  carDependent: "--status-critical",
};

export const BAND_VERDICT: Record<ComplaintBand, string> = {
  good: "Looks solid",
  fair: "Worth a closer look",
  poor: "Significant red flags",
};

/**
 * The access-half headline. Deliberately a separate vocabulary from
 * BAND_VERDICT: that copy is habitability language ("red flags"), which
 * reads as an accusation when what actually happened is "800m from a train".
 */
export const ACCESS_VERDICT: Record<AmenityBand, string> = {
  excellent: "Well connected",
  typical: "Some trade-offs",
  carDependent: "Car-dependent",
};

/**
 * Worst band of any number of complaint sections. Variadic, so the existing
 * two-argument call sites compile unchanged, and a third, fourth, fifth
 * section can be folded in without a new overload.
 *
 * Zero args -> "good", the correct identity for a worst-of fold: an absent
 * input must not out-rank every real one.
 *
 * Deliberately NOT tightened to `(first, ...rest)` — that looks safer but
 * breaks `overallBand(...bands)` with TS2556 when `bands` is a plain
 * `ComplaintBand[]`, which is exactly how VerdictBanner calls it.
 */
export function overallBand(...bands: ComplaintBand[]): ComplaintBand {
  const order: ComplaintBand[] = ["good", "fair", "poor"];
  if (bands.length === 0) return "good";
  return order[Math.max(...bands.map((b) => order.indexOf(b)))];
}

/**
 * The amenity analogue of overallBand — worst band across any number of
 * amenity sections. A separate function rather than a shared one parameterized
 * by vocabulary: the two band orders rank in opposite directions relative to
 * their own "first" entry (best-first here vs. best-first there too, but
 * different words), and keeping them separate is what makes passing a
 * ComplaintBand into the amenity fold (or vice versa) a type error instead of
 * a silent -1 from `indexOf`.
 *
 * Zero args -> "excellent", the amenity fold's identity — mirrors overallBand's
 * "zero args must not out-rank every real input" reasoning.
 */
export function overallAmenityBand(...bands: AmenityBand[]): AmenityBand {
  const order: AmenityBand[] = ["excellent", "typical", "carDependent"];
  if (bands.length === 0) return "excellent";
  return order[Math.max(...bands.map((b) => order.indexOf(b)))];
}

/**
 * Plain mean of component scores, rounded to the nearest integer — the
 * headline number for a section built from several sub-scores (liveability,
 * access). Deliberately not Math.min: the band already flags a weak
 * component via overallBand, so the number's job is to summarize overall
 * quality rather than discard every component but the worst.
 */
export function meanScore(...scores: number[]): number {
  return Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length);
}

export const STATUS_LABEL: Record<ComplaintStatus, string> = {
  open: "Open",
  "in-progress": "In Progress",
  closed: "Closed",
};

export const STATUS_VAR: Record<ComplaintStatus, string> = {
  open: "--status-critical",
  "in-progress": "--status-warning",
  closed: "--status-good",
};

export const CATEGORY_LABEL: Record<string, string> = {
  heatHotWater: "Heat / Hot Water",
  unsanitaryCondition: "Unsanitary Condition",
  plumbing: "Plumbing",
  noise: "Noise",
  parking: "Illegal Parking",
  streetCondition: "Street Condition",
};

export interface BaselineComparisonRow {
  key: string;
  label: string;
  count: number;
  scaledMedian: number;
  /** count / scaledMedian — how many times over (or under) the citywide median. */
  multiplier: number;
  colorVar: string;
}

/**
 * How this address's category counts compare to the citywide 311 baseline
 * (`CITYWIDE_BASELINE`, a fixed 24-month aggregate — see that file's doc
 * comment). The baseline's medians are scaled by `windowMonths / 24` so a
 * 3-month report isn't compared against a 24-month figure.
 *
 * Zero-count categories are dropped — a category with nothing filed has no
 * "notable" comparison to make — and the rest are sorted by multiplier
 * descending, worst-relative-to-median first. Callers slice to however many
 * rows they have room for.
 */
export function compareToBaseline(
  buildingCounts: BuildingCounts,
  blockCounts: BlockCounts,
  windowMonths: number,
): BaselineComparisonRow[] {
  const scale = windowMonths / CITYWIDE_BASELINE.windowMonths;
  const countsByTier: Record<string, Record<string, number>> = {
    "Building Health": buildingCounts,
    "Block Quality": blockCounts,
  };

  return CITYWIDE_BASELINE.tiers
    .flatMap((tier) => {
      const counts = countsByTier[tier.label] ?? {};
      return tier.buckets.map((bucket) => {
        const count = counts[bucket.key] ?? 0;
        const scaledMedian = bucket.median * scale;
        return {
          key: bucket.key,
          label: CATEGORY_LABEL[bucket.key] ?? bucket.key,
          count,
          scaledMedian,
          multiplier: scaledMedian > 0 ? count / scaledMedian : 0,
          colorVar: tier.colorVar,
        };
      });
    })
    .filter((row) => row.count > 0)
    .sort((a, b) => b.multiplier - a.multiplier);
}

// One-line "why this rating" summary for the verdict banner. Pulls the top
// 1-2 complaint categories that actually drove the overall band (from
// whichever complaint section matched it — could be either or both), plus
// how many of those are still open/in-progress.
//
// Takes an ARRAY rather than two positional sections: the two liveability
// tiers today, but nothing below this line assumes there are exactly two.
export function explainVerdict(
  complaintSections: ScoreSection<Record<string, number>>[],
  overall: ScoreBand,
  windowMonths: number,
): string {
  const sections = complaintSections.filter((s) => s.band === overall);

  const contributors = sections
    .flatMap((section) =>
      Object.entries(section.counts)
        .filter(([, count]) => count > 0)
        .map(([category, count]) => {
          const label = CATEGORY_LABEL[category] ?? category;
          const unresolved = (section.recentComplaints ?? []).filter(
            (c) => c.label === label && c.status !== "closed",
          ).length;
          return { category, count, label, unresolved };
        }),
    )
    .sort((a, b) => b.count - a.count);

  const label = BAND_LABEL[overall];

  if (contributors.length === 0) {
    return overall === "good"
      ? `Rated ${label} — no notable complaints recorded in the last ${windowMonths} months.`
      : `Rated ${label} based on limited complaint data in the last ${windowMonths} months.`;
  }

  const top = contributors.slice(
    0,
    contributors[1] && contributors[1].count > 0 ? 2 : 1,
  );
  const totalCount = top.reduce((sum, t) => sum + t.count, 0);
  const unresolved = top.reduce((sum, t) => sum + t.unresolved, 0);

  const lower = (label: string) => label.toLowerCase().replace(/ \/ /g, "/");
  const contributorsText =
    top.length === 2
      ? `${top[0].count} ${lower(top[0].label)} and ${top[1].count} ${lower(top[1].label)}`
      : `${top[0].count} ${lower(top[0].label)}`;
  const complaintWord = totalCount === 1 ? "complaint" : "complaints";
  const unresolvedClause =
    unresolved > 0 ? `, including ${unresolved} unresolved` : "";
  const connector = overall === "good" ? "with" : "due to";

  return `Rated ${label} ${connector} ${contributorsText} ${complaintWord} in the last ${windowMonths} months${unresolvedClause}.`;
}

/**
 * One-line "why this rating" summary for the access half of the banner.
 *
 * Mirrors explainVerdict's shape but reads distances, not counts. Leads with
 * whichever tier actually set the access band, and within that tier with the
 * single nearest amenity — the one detail in the whole section a reader can
 * independently check against a map.
 */
export function explainAccess(
  amenitySections: {
    label: string;
    section: AmenitySection<Record<string, AmenityMetric>>;
  }[],
  overall: AmenityBand,
): string {
  const verdict = ACCESS_VERDICT[overall];
  const matching = amenitySections.filter(
    ({ section }) => section.band === overall,
  );
  const pool = matching.length > 0 ? matching : amenitySections;

  let best: { label: string; bucket: string; metric: AmenityMetric } | null =
    null;
  for (const { label, section } of pool) {
    const nearest = nearestMetric(section.metrics);
    if (!nearest) continue;
    const meters = nearest.metric.meters as number;
    if (best === null || meters < (best.metric.meters as number)) {
      best = { label, bucket: String(nearest.bucket), metric: nearest.metric };
    }
  }

  if (!best) {
    return `${verdict} — nothing tracked within any of the access radii nearby.`;
  }

  const name =
    best.metric.name ??
    AMENITY_BUCKET_LABEL[best.bucket] ??
    "the nearest option";
  const walk = formatWalk(best.metric.meters);
  return `${verdict} — ${name} (${best.label.toLowerCase()}) is the closest, ${walk}.`;
}

// buildMonthlyTrend() lived here: it bucketed `recentComplaints` by month on the
// client. Removed rather than kept, because that list is capped at a row limit
// and on a dense block the most recent 200 records span days — bucketing them
// produced a cliff that read as "complaints started recently". /api/trend now
// aggregates by month in Socrata, which is truncation-proof and returns the
// same shape. Keeping this as a fallback would have meant two implementations
// of one chart, free to disagree.

// Suggested UI copy per confidenceReason — see API reference §Confidence.
// "stale_baseline_radius" is a backend misconfiguration and intentionally
// has no user-facing message; surface it to the team instead.
export const CONFIDENCE_MESSAGE: Record<string, string> = {
  no_complaints_found:
    "",
  no_baseline: "Score is not comparable to the rest of the city",
};
