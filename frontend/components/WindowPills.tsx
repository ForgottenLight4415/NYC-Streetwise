"use client";

import { TREND_WINDOW_OPTIONS, type TrendWindow } from "@/lib/api";

/**
 * The trend-window radiogroup: arrow-key roving tabindex, touch sizing and
 * data numerals. Rendered by TrendSection, one per complaint card. Kept as its
 * own component (it was once shared with a report-wide toolbar control) so
 * any future second use gets the same keyboard and accessibility behaviour.
 */
export function WindowPills({
  months,
  onMonthsChange,
  ariaLabel,
}: {
  months: TrendWindow;
  onMonthsChange: (months: TrendWindow) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
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
  );
}
