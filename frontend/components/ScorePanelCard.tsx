"use client";

import { useMemo, useState } from "react";
import { ComplaintBreakdownBars } from "./ComplaintBreakdownBars";
import { RecentComplaintsList } from "./RecentComplaintsList";
import { ScoreMeter } from "./ScoreMeter";
import { StatusBadge } from "./StatusBadge";
import { TrendSection } from "./TrendSection";
import { CONFIDENCE_MESSAGE } from "@/lib/score";
import { TREND_DEFAULT_MONTHS, type TrendWindow } from "@/lib/api";
import type { Complaint, Confidence, ScoreBand } from "@/lib/types";

/** "YYYY-MM-DD" for `months` months ago, for comparing against Complaint.date. */
function monthsAgoISO(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

export function ScorePanelCard({
  icon,
  title,
  panel,
  colorVar,
  description,
  tier,
  lat,
  lng,
  recentComplaints,
  recentComplaintsLoading,
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
  };
  colorVar: string;
  description: string;
  /** Which tier's history the trend chart should request. */
  tier: "building" | "block";
  lat: number;
  lng: number;
  /**
   * The tier's recent complaint points, fetched by the caller.
   *
   * Passed in rather than read off `panel` because the report used to *mutate*
   * the fetched score payload to attach them — which, now that the payload is
   * an SWR cache entry, would be writing into the cache. Callers that never
   * fetch them (the compare view) pass neither prop and the section is hidden;
   * `undefined` with `recentComplaintsLoading` means still in flight, and `[]`
   * means none were found.
   */
  recentComplaints?: Complaint[];
  recentComplaintsLoading?: boolean;
}) {
  // The window lives here, not inside TrendSection, so it scopes the chart AND
  // the complaint list below it. Split between the two, a panel filtered to 3
  // months still listed complaints from 2024.
  const [months, setMonths] = useState<TrendWindow>(
    TREND_DEFAULT_MONTHS as TrendWindow,
  );
  // The TOTAL, not the series it came from. Lifting the array up meant a new
  // array identity on every window change, which re-rendered this whole card —
  // meter, category bars, complaint list — to recompute one number.
  const [windowTotal, setWindowTotal] = useState<number | null>(null);

  const totalComplaints = Object.values(panel.counts).reduce(
    (sum, n) => sum + n,
    0,
  );

  // Filtered client-side, costing no request. The list is newest-first, so its
  // first N are the first N of any window it covers, and narrowing by date is a
  // prefix operation — correct even when the underlying feed was row-capped.
  const windowed = useMemo(() => {
    const cutoff = monthsAgoISO(months);
    return (recentComplaints ?? []).filter((c) => c.date >= cutoff);
  }, [recentComplaints, months]);

  const confidenceMessage =
    panel.confidence === "low" && panel.confidenceReason
      ? CONFIDENCE_MESSAGE[panel.confidenceReason]
      : null;

  return (
    <div
      className="flex flex-col gap-5 rounded-lg bg-(--surface-1) p-5 sm:p-6"
      style={{
        boxShadow: "var(--shadow-md)",
        border: "1px solid var(--border-hairline)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
            style={{
              color: `var(${colorVar}-ink)`,
              background: `color-mix(in srgb, var(${colorVar}) 14%, transparent)`,
            }}
          >
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="font-semibold text-(--text-primary)">{title}</h2>
            <p className="text-xs text-(--text-muted)">{description}</p>
          </div>
        </div>
        <StatusBadge band={panel.band} />
      </div>

      <div className="flex items-center gap-4 sm:gap-5">
        <ScoreMeter score={panel.score} band={panel.band} size={96} />
        <div className="min-w-0 flex-1 text-sm text-(--text-secondary)">
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
          {confidenceMessage && (
            <p
              className="rounded-lg my-1 px-3 py-2 text-xs"
              style={{
                color: "var(--status-warning-ink)",
                background:
                  "color-mix(in srgb, var(--status-warning) 14%, transparent)",
              }}
            >
              {confidenceMessage}
            </p>
          )}
        </div>
      </div>

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
        />
      </div>

      {/* Both sections below are scoped to this panel's own tier and to the
          window selected above, so they cover the same complaints as each
          other and as the category breakdown. */}
      <TrendSection
        lat={lat}
        lng={lng}
        tier={tier}
        colorVar={colorVar}
        months={months}
        onMonthsChange={setMonths}
        onWindowTotalChange={setWindowTotal}
      />

      {(recentComplaints !== undefined || recentComplaintsLoading) && (
        <div>
          <p className="mb-2.5 text-xs font-medium uppercase tracking-wide text-(--text-muted)">
            Recent complaints
          </p>
          {recentComplaints === undefined ? (
            // Height-matched to five collapsed rows so the card does not grow
            // under the cursor when the list lands. This section is the reason
            // the whole report used to block: it is now the only thing still
            // waiting once the scores are on screen.
            <div
              className="h-55 animate-pulse rounded-md"
              style={{ background: "var(--surface-2)" }}
              aria-label="Loading recent complaints"
            />
          ) : (
            <RecentComplaintsList
              complaints={windowed}
              months={months}
              windowTotal={windowTotal}
              tier={tier}
              lat={lat}
              lng={lng}
              radiusMeters={panel.radiusMeters}
              panelLabel={title}
            />
          )}
        </div>
      )}
    </div>
  );
}
