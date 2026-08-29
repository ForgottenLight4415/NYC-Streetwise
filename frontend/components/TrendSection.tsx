"use client";

import { useEffect, useMemo } from "react";
import { TrendSparkline } from "./TrendSparkline";
import { TREND_WINDOW_OPTIONS, type TrendWindow } from "@/lib/api";
import { useTrend } from "@/lib/hooks";

/**
 * The trend chart plus its window selector.
 *
 * Split out of ScorePanelCard because it is the one part of that card with its
 * own data source and its own state — the card is otherwise a pure render of
 * the score payload.
 *
 * Series come from /api/trend, which aggregates by month server-side. That
 * matters: the old chart bucketed the capped complaint LIST, so on a dense
 * block it charted the most recent 200 records — a couple of weeks — and drew
 * a cliff that read as "complaints started recently". This cannot be
 * truncated; every window returns one point per month.
 *
 * The window is owned by ScorePanelCard rather than by this component, because
 * it also scopes that card's complaint list. Keeping it here was the bug: a
 * panel filtered to 3 months still listed complaints from 2024.
 */
export function TrendSection({
  lat,
  lng,
  tier,
  colorVar,
  months,
  onMonthsChange,
  onWindowTotalChange,
}: {
  lat: number;
  lng: number;
  tier: "building" | "block";
  colorVar: string;
  months: TrendWindow;
  onMonthsChange: (months: TrendWindow) => void;
  /**
   * Reports the visible window's total up to the card, which shows it above the
   * complaint list. A NUMBER, not the series: lifting the array meant a fresh
   * identity on every window change and a re-render of the entire card to
   * derive one integer from it.
   */
  onWindowTotalChange?: (total: number | null) => void;
}) {
  // Always the widest window, sliced down for display. Every window is a suffix
  // of a longer one — the last 9 months are the last 9 entries of the last 24 —
  // so one request answers all six, and switching between them costs nothing.
  //
  // The result is TAGGED with the address it belongs to and compared against the
  // current one, rather than cleared by the effect. That keeps a previous
  // address's chart from showing under a new one without a state write during
  // render — and it is the reason this survives StrictMode's double-invoke,
  // where a "have we started?" ref would cancel the first run and then skip the
  // second, leaving the chart loading forever.
  // Keyed by coordinate+tier in the SWR cache, which is what the hand-rolled
  // `fetched.key === key` tagging this replaces was doing by hand — and it is
  // shared, so ReportView's prefetch at geocode time means this usually finds
  // the request already in flight rather than starting a new one.
  const { data, isLoading } = useTrend({ lat, lng }, tier);

  // fetchTrend swallows its errors and answers [], so an empty series is the
  // only failure signal there is. Distinguished from "still loading" by SWR.
  const failed = !isLoading && data !== undefined && data.length === 0;
  const series = useMemo(
    () => (data && data.length > 0 ? data.slice(-months) : null),
    [data, months],
  );

  const windowTotal = series
    ? series.reduce((sum, p) => sum + p.count, 0)
    : null;

  useEffect(() => {
    onWindowTotalChange?.(windowTotal);
    // Deliberately not depending on the callback identity: the parent passes a
    // plain setState, and including it would re-fire this on every parent
    // render. The total is a number, so this now runs only when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowTotal]);

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-(--text-muted)">
          {months}-month trend
        </p>

        <div
          role="radiogroup"
          aria-label={`Trend window for ${tier === "building" ? "Building Health" : "Block Quality"}`}
          className="inline-flex items-center gap-0.5 rounded-full border p-0.5"
          style={{ borderColor: "var(--border-hairline)" }}
        >
          {TREND_WINDOW_OPTIONS.map((option, i) => {
            const selected = option === months;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${option} months`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onMonthsChange(option)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  e.preventDefault();
                  const next =
                    TREND_WINDOW_OPTIONS[
                      (i +
                        (e.key === "ArrowRight"
                          ? 1
                          : TREND_WINDOW_OPTIONS.length - 1)) %
                        TREND_WINDOW_OPTIONS.length
                    ];
                  onMonthsChange(next);
                }}
                className="font-data min-w-7 rounded-full px-1.5 py-1 text-[11px] font-medium transition-colors"
                style={{
                  background: selected ? "var(--surface-2)" : "transparent",
                  color: selected ? "var(--text-primary)" : "var(--text-muted)",
                }}
              >
                {option}
              </button>
            );
          })}
          <span className="pr-1.5 text-[11px] text-(--text-muted)">mo</span>
        </div>
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
