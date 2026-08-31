import { ScoreMeter } from "./ScoreMeter";
import { StatusBadge } from "./StatusBadge";
import { BAND_VAR, CONFIDENCE_MESSAGE } from "@/lib/score";
import type { Confidence, ScoreBand } from "@/lib/types";

/**
 * The chrome every scored panel shares — card, header, meter, band badge,
 * confidence callout — split out of ScorePanelCard so a sibling amenity card
 * can reuse it without inheriting ScorePanelCard's complaint-specific state
 * (the trend window, the recent-complaints list) which means nothing for a
 * subway station.
 *
 * The old complaint-count line becomes the `summary` slot: both card kinds
 * render it in the same place, so the header and meter stay pixel-identical
 * between them.
 *
 * `compact` swaps the 96px donut meter for a smaller score chip and tightens
 * the card's padding — used by the amenity cards in the dashboard layout,
 * where three cards now share a row that used to hold one. Every metric row,
 * the description, the badge, and the confidence callout are unchanged; only
 * the meter's screen space shrinks.
 */
export function PanelShell({
  icon,
  title,
  description,
  colorVar,
  score,
  band,
  confidence,
  confidenceReason,
  summary,
  compact = false,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  colorVar: string;
  score: number;
  band: ScoreBand;
  confidence: Confidence;
  confidenceReason: string | null;
  /** The line beside the meter — e.g. a complaint count, or a nearest-amenity
   *  sentence. Owned by the caller; the two kinds have nothing to generalise. */
  summary: React.ReactNode;
  compact?: boolean;
  children?: React.ReactNode;
}) {
  const confidenceMessage =
    confidence === "low" && confidenceReason
      ? CONFIDENCE_MESSAGE[confidenceReason]
      : null;

  return (
    <div
      className={
        compact
          ? "flex flex-col gap-4 rounded-lg bg-(--surface-1) p-4"
          : "flex flex-col gap-5 rounded-lg bg-(--surface-1) p-5 sm:p-6"
      }
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
        <StatusBadge band={band} />
      </div>

      <div className="flex items-center gap-4 sm:gap-5">
        {compact ? (
          <span className="flex shrink-0 items-baseline gap-1">
            <span
              className="font-data text-2xl font-semibold"
              style={{ color: `var(${BAND_VAR[band]}-ink)` }}
            >
              {score}
            </span>
            <span className="font-data text-xs text-(--text-muted)">/100</span>
          </span>
        ) : (
          <ScoreMeter score={score} band={band} size={96} />
        )}
        <div className="min-w-0 flex-1 text-sm text-(--text-secondary)">
          {summary}
          {confidenceMessage && (
            <p
              className="rounded-lg my-1 px-4 py-1 text-xs w-fit"
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

      {children}
    </div>
  );
}
