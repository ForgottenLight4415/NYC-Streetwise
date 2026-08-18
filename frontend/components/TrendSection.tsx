"use client";

import { useEffect, useState } from "react";
import { TrendSparkline } from "./TrendSparkline";
import {
  fetchTrend,
  TREND_MAX_MONTHS,
  TREND_WINDOW_OPTIONS,
  type TrendWindow,
} from "@/lib/api";
import type { TrendPoint } from "@/lib/types";

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
  onSeriesChange,
}: {
  lat: number;
  lng: number;
  tier: "building" | "block";
  colorVar: string;
  months: TrendWindow;
  onMonthsChange: (months: TrendWindow) => void;
  /** Lifts the fetched series up so the card can total the visible window. */
  onSeriesChange?: (series: TrendPoint[] | null) => void;
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
  const key = `${lat},${lng},${tier}`;
  const [fetched, setFetched] = useState<{
    key: string;
    points?: TrendPoint[];
    failed?: boolean;
  } | null>(null);

  const current = fetched?.key === key ? fetched : null;
  const full = current?.points ?? null;
  const failed = current?.failed ?? false;

  useEffect(() => {
    let cancelled = false;

    fetchTrend(lat, lng, tier, TREND_MAX_MONTHS).then((points) => {
      if (cancelled) return;
      setFetched(points.length === 0 ? { key, failed: true } : { key, points });
    });

    return () => {
      cancelled = true;
    };
  }, [key, lat, lng, tier]);

  const series = full ? full.slice(-months) : null;

  useEffect(() => {
    onSeriesChange?.(series);
    // series is derived from full+months; depending on those avoids rebuilding
    // the array identity on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full, months]);

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
