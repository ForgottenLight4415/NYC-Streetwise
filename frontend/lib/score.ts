import type { ComplaintStatus, ScoreBand, ScoreSection } from "./types";

export function bandForScore(score: number): ScoreBand {
  if (score >= 70) return "good";
  if (score >= 40) return "fair";
  return "poor";
}

export const BAND_LABEL: Record<ScoreBand, string> = {
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

export const BAND_VERDICT: Record<ScoreBand, string> = {
  good: "Looks solid",
  fair: "Worth a closer look",
  poor: "Significant red flags",
};

export function overallBand(a: ScoreBand, b: ScoreBand): ScoreBand {
  const order: ScoreBand[] = ["good", "fair", "poor"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

export const BAND_VAR: Record<ScoreBand, string> = {
  good: "--status-good",
  fair: "--status-warning",
  poor: "--status-critical",
};

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

// One-line "why this rating" summary for the verdict banner. Pulls the top
// 1-2 complaint categories that actually drove the overall band (from
// whichever of building/block matched it — could be either or both), plus
// how many of those are still open/in-progress.
export function explainVerdict(
  building: ScoreSection<Record<string, number>>,
  block: ScoreSection<Record<string, number>>,
  overall: ScoreBand,
  windowMonths: number
): string {
  const sections = [building, block].filter((s) => s.band === overall);

  const contributors = sections
    .flatMap((section) =>
      Object.entries(section.counts)
        .filter(([, count]) => count > 0)
        .map(([category, count]) => {
          const label = CATEGORY_LABEL[category] ?? category;
          const unresolved = (section.recentComplaints ?? []).filter(
            (c) => c.label === label && c.status !== "closed"
          ).length;
          return { category, count, label, unresolved };
        })
    )
    .sort((a, b) => b.count - a.count);

  const label = BAND_LABEL[overall];

  if (contributors.length === 0) {
    return overall === "good"
      ? `Rated ${label} — no notable complaints recorded in the last ${windowMonths} months.`
      : `Rated ${label} based on limited complaint data in the last ${windowMonths} months.`;
  }

  const top = contributors.slice(0, contributors[1] && contributors[1].count > 0 ? 2 : 1);
  const totalCount = top.reduce((sum, t) => sum + t.count, 0);
  const unresolved = top.reduce((sum, t) => sum + t.unresolved, 0);

  const lower = (label: string) => label.toLowerCase().replace(/ \/ /g, "/");
  const contributorsText =
    top.length === 2
      ? `${top[0].count} ${lower(top[0].label)} and ${top[1].count} ${lower(top[1].label)}`
      : `${top[0].count} ${lower(top[0].label)}`;
  const complaintWord = totalCount === 1 ? "complaint" : "complaints";
  const unresolvedClause = unresolved > 0 ? `, including ${unresolved} unresolved` : "";
  const connector = overall === "good" ? "with" : "due to";

  return `Rated ${label} ${connector} ${contributorsText} ${complaintWord} in the last ${windowMonths} months${unresolvedClause}.`;
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
    "No records found at this location — this may not be a building address.",
  no_baseline: "Score is not comparable to the rest of the city.",
};
