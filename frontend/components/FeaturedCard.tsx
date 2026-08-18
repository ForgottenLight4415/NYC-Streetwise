import Link from "next/link";
import { BAND_LABEL, BAND_VAR, BAND_VERDICT, CATEGORY_LABEL, overallBand } from "@/lib/score";
import type { ReportResponse } from "@/lib/types";

function ScoreBlob({ score, colorVar }: { score: number; colorVar: string }) {
  return (
    <span
      // Filled with the `-ink` value, not the graphic one: white on
      // --series-block was 3.1:1, and on the old amber it was 2.4:1. The ink
      // variants are picked so white clears 4.5:1 on every band.
      className="font-data inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
      style={{ background: `var(${colorVar}-ink)`, color: "#ffffff" }}
    >
      {score}
    </span>
  );
}

function PanelRow({
  label,
  score,
  total,
  topCategory,
  colorVar,
}: {
  label: string;
  score: number;
  total: number;
  topCategory: string | null;
  colorVar: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <ScoreBlob score={score} colorVar={colorVar} />
        <div className="min-w-0">
          <p className="font-medium text-[color:var(--text-primary)] leading-tight">{label}</p>
          {topCategory && (
            <p className="text-xs text-[color:var(--text-muted)] truncate">Top: {topCategory}</p>
          )}
        </div>
      </div>
      <span className="shrink-0 text-xs text-[color:var(--text-muted)]">
        <span className="font-data">{total}</span> complaint{total !== 1 ? "s" : ""}
      </span>
    </div>
  );
}

export function FeaturedCard({
  address,
  borough,
  data,
}: {
  address: string;
  borough: string;
  data: ReportResponse;
}) {
  const { buildingHealth, blockQuality } = data;

  const band = overallBand(buildingHealth.band, blockQuality.band);
  // The stripe is a graphic and can use the saturated value; the verdict and
  // the borough chip are words and use the ink one.
  const accentColor = `var(${BAND_VAR[band]})`;
  const accentInk = `var(${BAND_VAR[band]}-ink)`;

  const topBuildingCat = Object.entries(buildingHealth.counts).sort(([, a], [, b]) => b - a)[0]?.[0];
  const topBlockCat = Object.entries(blockQuality.counts).sort(([, a], [, b]) => b - a)[0]?.[0];

  const buildingTotal = Object.values(buildingHealth.counts).reduce((sum, n) => sum + n, 0);
  const blockTotal = Object.values(blockQuality.counts).reduce((sum, n) => sum + n, 0);

  const streetAddress = address.split(",")[0];
  const restAddress = address.split(",").slice(1).join(",").trim();

  return (
    <Link
      href={`/report?address=${encodeURIComponent(address)}`}
      className="card-pop group flex flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[color:var(--surface-1)]"
      style={{ border: "1px solid var(--border-hairline)" }}
    >
      <div className="h-1.5 w-full" style={{ background: accentColor }} />

      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p
              className="font-display text-lg font-semibold leading-tight tracking-tight"
              style={{ color: accentInk }}
            >
              {BAND_VERDICT[band]}
            </p>
            <p className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
              {BAND_LABEL[band]}
            </p>
          </div>
          <span
            className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{
              color: accentInk,
              background: `color-mix(in srgb, ${accentColor} 14%, transparent)`,
            }}
          >
            {borough}
          </span>
        </div>

        <div className="border-t pt-3" style={{ borderColor: "var(--gridline)" }}>
          <p className="font-semibold text-[color:var(--text-primary)] leading-snug">{streetAddress}</p>
          <p className="text-xs text-[color:var(--text-muted)] mt-0.5">{restAddress}</p>
        </div>

        <div className="flex flex-col gap-3">
          <PanelRow
            label="Building Health"
            score={buildingHealth.score}
            total={buildingTotal}
            topCategory={topBuildingCat ? (CATEGORY_LABEL[topBuildingCat] ?? null) : null}
            colorVar="--series-building"
          />
          <PanelRow
            label="Block Quality"
            score={blockQuality.score}
            total={blockTotal}
            topCategory={topBlockCat ? (CATEGORY_LABEL[topBlockCat] ?? null) : null}
            colorVar="--series-block"
          />
        </div>

        <div
          className="border-t pt-3 text-xs font-semibold text-[color:var(--brand-ink)] transition-colors group-hover:text-[color:var(--brand-strong)]"
          style={{ borderColor: "var(--gridline)" }}
        >
          View full report →
        </div>
      </div>
    </Link>
  );
}
