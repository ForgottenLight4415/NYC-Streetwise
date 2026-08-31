"use client";

import { ComplaintBreakdownBars } from "./ComplaintBreakdownBars";
import { PanelShell } from "./PanelShell";
import { TrendSection } from "./TrendSection";
import type { TrendWindow } from "@/lib/api";
import type {
  ComplaintStatus,
  ComplaintTierId,
  Confidence,
  ScoreBand,
} from "@/lib/types";

export function ScorePanelCard({
  icon,
  title,
  panel,
  colorVar,
  description,
  tier,
  lat,
  lng,
  months,
  compact = false,
}: {
  icon: React.ReactNode;
  title: string;
  panel: {
    score: number;
    band: ScoreBand;
    radiusMeters: number;
    counts: Record<string, number>;
    confidence: Confidence;
    confidenceReason: string | null;
    // Per-category scores. /api/score always sends these; they are what lets the
    // "Why this score?" disclosure name the category that actually drove the
    // rating rather than just the largest raw count.
    bucketScores?: Record<string, number | undefined>;
    // Per-category status breakdown, for the segmented category bar. Optional —
    // see the field's own doc on ScoreSection in lib/types.ts for when it's
    // absent and why ComplaintBreakdownBars must fall back cleanly then.
    bucketStatusCounts?: Record<string, Record<ComplaintStatus, number> | undefined>;
  };
  colorVar: string;
  description: string;
  /** Which tier's history the trend chart should request. */
  tier: ComplaintTierId;
  lat: number;
  lng: number;
  /** The report's one global trend window, owned by ReportBody so it also
   *  scopes ActivitySpine below. */
  months: TrendWindow;
  /** Swaps PanelShell's 96px meter for the small score chip — see PanelShell's
   *  own doc for why. Threaded through so complaint cards can match the
   *  amenity cards' density now that ReportBody no longer needs the meter's
   *  full width to justify a two-column row at a wide breakpoint. */
  compact?: boolean;
}) {
  const totalComplaints = Object.values(panel.counts).reduce(
    (sum, n) => sum + n,
    0,
  );

  const summary = (
    <p>
      <span className="font-data font-medium text-(--text-primary)">
        {totalComplaints}
      </span>{" "}
      complaints within{" "}
      <span className="font-data font-medium text-(--text-primary)">
        {panel.radiusMeters}m
      </span>
      .
    </p>
  );

  return (
    <PanelShell
      icon={icon}
      title={title}
      description={description}
      colorVar={colorVar}
      score={panel.score}
      band={panel.band}
      confidence={panel.confidence}
      confidenceReason={panel.confidenceReason}
      summary={summary}
      compact={compact}
    >
      <div>
        <p className="mb-2.5 text-xs font-medium uppercase tracking-wide text-(--text-muted)">
          By category
        </p>
        <ComplaintBreakdownBars
          counts={panel.counts}
          colorVar={colorVar}
          tier={tier}
          score={panel.score}
          bucketScores={panel.bucketScores}
          bucketStatusCounts={panel.bucketStatusCounts}
        />
      </div>

      <TrendSection lat={lat} lng={lng} tier={tier} colorVar={colorVar} months={months} />
    </PanelShell>
  );
}
