import { useMemo } from "react";
import { AMENITY_CATEGORIES, COMPLAINT_CATEGORIES } from "@/lib/categories";
import { useExplanation, type useReportPanels } from "@/lib/hooks";
import { computeOverviewMetrics } from "@/lib/reportMetrics";
import {
  ACCESS_VERDICT,
  BAND_VAR,
  BAND_VERDICT,
  compareToBaseline,
  explainAccess,
  explainVerdict,
} from "@/lib/score";
import type { ReportResponse, ScoreBand } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

type Panels = ReturnType<typeof useReportPanels>;

/**
 * One of the two headlines: just the band word and its badge. The prose that
 * used to live under each half — one line per category — is now the ONE
 * combined summary below both halves; see the component doc for why.
 */
function Half({
  eyebrow,
  band,
  verdict,
}: {
  eyebrow: string;
  band: ScoreBand;
  verdict: string;
}) {
  const ink = `var(${BAND_VAR[band]}-ink)`;
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-(--text-muted)">
        {eyebrow}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className="font-display text-xl font-semibold tracking-tight sm:text-2xl"
          style={{ color: ink }}
        >
          {verdict}
        </span>
        <StatusBadge band={band} />
      </div>
    </div>
  );
}

/**
 * Two verdicts, side by side: liveability (building + block) and access
 * (transit + parks + bike + walkability), plus the one combined summary
 * paragraph below both.
 *
 * Folding all six sections into one band would let a spotless building
 * 900m from a train render "Significant red flags" — and because
 * `explainVerdict` filters for sections matching the overall band, it would
 * find none and fall through to a fabricated "based on limited complaint
 * data", which is false. Two headlines, two vocabularies (BAND_VERDICT vs.
 * ACCESS_VERDICT), make that unrepresentable.
 *
 * The access half is omitted entirely when the report has no amenity
 * sections — a `/api/showcase` document cached before this feature shipped,
 * or a live report where the amenity datasets failed to load server-side.
 *
 * `panels` is optional: the compare view renders two of these side by side
 * and does not fetch the AI summary for either, to keep that page cheap and
 * fast. Omitting it here reproduces that — both halves fall straight to
 * their deterministic sentence, never to a loading state.
 *
 * `showAddress` defaults to true (every existing caller renders it). The
 * report page's dashboard layout passes false: its sticky ReportToolbar owns
 * the address heading now, so the banner would otherwise duplicate it.
 *
 * Renders ONLY the headlines + summary — the radial chart and the KPI tiles
 * that used to live in this same card now live in `OverviewHeader`, rendered
 * separately by `ReportBody` for both layouts (beside this banner in the
 * page layout's 5-column split; below it in the compare view's stacked
 * column). This component no longer renders its own tile grid, so `layout`
 * only changes the headline arrangement, not what's included.
 */
export function VerdictBanner({
  report,
  panels,
  coords,
  address,
  windowMonths,
  showAddress = true,
  layout = "page",
}: {
  report: ReportResponse;
  panels?: Panels;
  /**
   * Used for the combined AI summary fetch. Optional because the compare
   * view (no `panels`) does not always have a reason to pass it either; when
   * either is missing, this falls straight to the deterministic sentence,
   * same as every other AI fetch in this banner.
   */
  coords?: { lat: number; lng: number };
  address: string;
  windowMonths: number;
  showAddress?: boolean;
  /** Changes only the headline arrangement — see the component doc. */
  layout?: "page" | "column";
}) {
  const complaintSections = COMPLAINT_CATEGORIES.map((c) => report[c.key]);
  const amenityCats = AMENITY_CATEGORIES.filter((c) => report[c.key] != null);
  const hasAccess = amenityCats.length > 0;

  // `report` is a stable SWR cache identity — see computeOverviewMetrics's
  // own doc comment — so this only re-folds when the report itself changes,
  // not on every VerdictBanner re-render.
  const { liveabilityBand, accessBand } = useMemo(
    () => computeOverviewMetrics(report),
    [report],
  );

  const color = `var(${BAND_VAR[liveabilityBand]})`;

  // ONE combined summary for the whole banner, not one line per category —
  // see ReportSummary in lib/types.ts and prompt.js's buildOverallSummaryPrompt.
  // Gated on `panels`, same signal every other AI fetch in this component
  // used to read off `panels?.[key].ai`: no panels means the compare view,
  // which fetches no AI text at all and always shows the deterministic
  // sentence below.
  const summaryAi = useExplanation(panels ? coords : undefined, "overall", report.summary);
  const summaryLoading = summaryAi.isLoading;
  const summaryText =
    summaryAi.text ??
    [
      explainVerdict(complaintSections, liveabilityBand, windowMonths),
      hasAccess
        ? explainAccess(
            amenityCats.map((c) => ({ label: c.label, section: report[c.key]! })),
            accessBand,
          )
        : null,
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <div
      className={`rounded-lg p-5 sm:p-6 ${layout === "page" ? "h-full" : ""}`}
      style={{
        boxShadow: "var(--shadow-md)",
        border: "1px solid var(--border-hairline)",
        borderLeft: `3px solid ${color}`,
        background: `color-mix(in srgb, ${color} 5%, var(--surface-1))`,
      }}
    >
      {showAddress && (
        <h1 className="font-display text-lg font-semibold leading-snug text-(--text-primary) sm:text-xl">
          {address}
        </h1>
      )}

      <div
        className={
          hasAccess
            ? `${showAddress ? "mt-4" : ""} grid gap-5 sm:grid-cols-2`
            : showAddress
              ? "mt-4"
              : ""
        }
      >
        <Half
          eyebrow="Liveability"
          band={liveabilityBand}
          verdict={BAND_VERDICT[liveabilityBand]}
        />
        {hasAccess && (
          <Half
            eyebrow="Access"
            band={accessBand}
            verdict={ACCESS_VERDICT[accessBand]}
          />
        )}
      </div>

      {summaryLoading ? (
        <p className="mt-4 animate-pulse text-sm text-(--text-muted)">
          Reasoning...
        </p>
      ) : (
        <p className="mt-4 text-sm text-(--text-secondary)">{summaryText}</p>
      )}

      {layout === "page" &&
        (() => {
          const rows = compareToBaseline(
            report.buildingHealth.counts,
            report.blockQuality.counts,
            windowMonths,
          ).slice(0, 2);
          if (rows.length === 0) return null;
          return (
            <div
              className="mt-4 border-t pt-4"
              style={{ borderColor: "var(--border-hairline)" }}
            >
              <p className="text-xs font-medium uppercase tracking-wide text-(--text-muted)">
                vs. the citywide median
              </p>
              <div className="mt-2 flex flex-col gap-1.5">
                {rows.map((r) => (
                  <div
                    key={r.key}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="text-(--text-secondary)">{r.label}</span>
                    <span className="font-data text-(--text-primary)">
                      {r.count.toLocaleString()}
                      <span className="text-(--text-muted)">
                        {" "}
                        · median {Math.round(r.scaledMedian).toLocaleString()}
                      </span>
                      <span
                        className="ml-1.5"
                        style={{
                          color:
                            r.multiplier > 1
                              ? "var(--status-critical-ink)"
                              : "var(--status-good-ink)",
                        }}
                      >
                        ({r.multiplier.toFixed(1)}×)
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
