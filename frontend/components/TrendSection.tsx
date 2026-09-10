"use client";

import { TrendSparkline } from "./TrendSparkline";
import { WindowPills } from "./WindowPills";
import type { TrendWindow } from "@/lib/api";
import { useTrend } from "@/lib/hooks";
import { sliceWindow } from "@/lib/reportMetrics";
import type { ComplaintTierId } from "@/lib/types";

/** A lookup, not a ternary - a ternary silently mislabels any tier beyond
 *  the two it was written for. */
const TIER_LABEL: Record<ComplaintTierId, string> = {
  building: "Building Health",
  block: "Block Quality",
};

/**
 * The trend chart plus its window selector.
 *
 * Split out of ScorePanelCard because it is the one part of that card with its
 * own data source and its own state - the card is otherwise a pure render of
 * the score payload.
 *
 * Series come from /api/trend, which aggregates by month server-side. That
 * matters: the old chart bucketed the capped complaint LIST, so on a dense
 * block it charted the most recent 200 records - a couple of weeks - and drew
 * a cliff that read as "complaints started recently". This cannot be
 * truncated; every window returns one point per month.
 *
 * `onMonthsChange` is optional: on the report page the window now lives in
 * ReportToolbar and is passed down as a prop, so this renders only the
 * "{months}-month trend" label with no control of its own. The compare
 * column still owns its window locally and passes the setter.
 */
export function TrendSection({
  lat,
  lng,
  tier,
  colorVar,
  months,
  onMonthsChange,
}: {
  lat: number;
  lng: number;
  tier: ComplaintTierId;
  colorVar: string;
  months: TrendWindow;
  onMonthsChange?: (months: TrendWindow) => void;
}) {
  // Always the widest window, sliced down for display. Every window is a suffix
  // of a longer one - the last 9 months are the last 9 entries of the last 24 -
  // so one request answers all six, and switching between them costs nothing.
  //
  // Keyed by coordinate+tier in the SWR cache, so ReportView's prefetch at
  // geocode time means this usually finds the request already in flight
  // rather than starting a new one.
  const { data, isLoading } = useTrend({ lat, lng }, tier);

  // fetchTrend swallows its errors and answers [], so an empty series is the
  // only failure signal there is. Distinguished from "still loading" by SWR.
  const failed = !isLoading && data !== undefined && data.length === 0;
  const series = sliceWindow(data, months);

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-(--text-muted)">
          {months}-month trend
        </p>

        {onMonthsChange && (
          <WindowPills
            months={months}
            onMonthsChange={onMonthsChange}
            ariaLabel={`Trend window for ${TIER_LABEL[tier]}`}
          />
        )}
      </div>

      {failed ? (
        <p className="text-xs text-(--text-muted)">
          Couldn&rsquo;t load the trend for this window.
        </p>
      ) : series ? (
        <TrendSparkline data={series} colorVar={colorVar} />
      ) : (
        // Height-matched to the chart so switching windows doesn't jump the
        // card and shove the complaint list under the cursor.
        <div
          className="h-34 animate-pulse rounded-md"
          style={{ background: "var(--surface-2)" }}
          aria-label="Loading trend"
        />
      )}
    </div>
  );
}
