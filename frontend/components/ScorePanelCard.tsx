"use client";

import { useState } from "react";
import { ComplaintBreakdownBars } from "./ComplaintBreakdownBars";
import { PanelShell } from "./PanelShell";
import { TrendSection } from "./TrendSection";
import { formatDistance } from "@/lib/amenities";
import { TREND_DEFAULT_MONTHS, type TrendWindow } from "@/lib/api";
import type {
  ComplaintStatus,
  ComplaintTierId,
  Confidence,
  ScoreBand,
} from "@/lib/types";

/**
 * Each tier's starting trend window. A lookup, not a ternary, so a third tier
 * is a type error here rather than silently getting another tier's default.
 * Building history at 25m is sparse (a handful of complaints a year is
 * typical), so it starts at the full 24 months where a shape is visible;
 * block history is dense enough to read at the shorter default.
 */
const DEFAULT_WINDOW: Record<ComplaintTierId, TrendWindow> = {
  building: TREND_DEFAULT_MONTHS as TrendWindow,
  block: TREND_DEFAULT_MONTHS as TrendWindow,
};

export function ScorePanelCard({
  icon,
  title,
  panel,
  colorVar,
  description,
  tier,
  lat,
  lng,
  windowMonths,
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
    // Per-category status breakdown, for the segmented category bar. Optional -
    // see the field's own doc on ScoreSection in lib/types.ts for when it's
    // absent and why ComplaintBreakdownBars must fall back cleanly then.
    bucketStatusCounts?: Record<
      string,
      Record<ComplaintStatus, number> | undefined
    >;
  };
  colorVar: string;
  description: string;
  /** Which tier's history the trend chart should request. */
  tier: ComplaintTierId;
  lat: number;
  lng: number;
  /** The window the score's counts cover (the report's `meta.windowMonths`,
   *  i.e. the backend's WINDOW_MONTHS), stated beside the count. */
  windowMonths: number;
  /** Swaps PanelShell's 96px meter for the small score chip - see PanelShell's
   *  own doc for why. Threaded through so complaint cards can match the
   *  amenity cards' density now that ReportBody no longer needs the meter's
   *  full width to justify a two-column row at a wide breakpoint. */
  compact?: boolean;
}) {
  // This card's own trend window. Per card, not report-wide: the window drives
  // nothing but the trend chart below it (the counts above are always the
  // full scoring window), and the two tiers want different ones - building
  // history at 25m is sparse enough to need 18-24 months to show a shape,
  // while a block's is dense enough to read at 3-6.
  const [months, setMonths] = useState<TrendWindow>(DEFAULT_WINDOW[tier]);

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
        {formatDistance(panel.radiusMeters)}
      </span>{" "}
      {/* The score's own window, not the trend window below: these are the
          counts the score was computed from, whatever the pills are set to. */}
      in the last {windowMonths} months.
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

      <TrendSection
        lat={lat}
        lng={lng}
        tier={tier}
        colorVar={colorVar}
        months={months}
        onMonthsChange={setMonths}
      />
    </PanelShell>
  );
}
