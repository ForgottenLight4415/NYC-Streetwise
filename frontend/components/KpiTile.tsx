import { yoyDelta } from "@/lib/reportMetrics";
import { useTrend } from "@/lib/hooks";
import type { ScoreBand } from "@/lib/types";
import { ClockIcon, TrendDownIcon, TrendUpIcon } from "./icons";
import { StatusBadge } from "./StatusBadge";

interface KpiDelta {
  /** Signed percent change. Positive means the number went up. */
  pct: number;
  /** True when a NEGATIVE change is the good outcome - e.g. complaint counts,
   *  where fewer is better. Determines the color, not the arrow: the arrow
   *  always points the way the number actually moved. */
  invert?: boolean;
  /** e.g. "vs prior 12 mo". */
  label: string;
}

/**
 * One KPI tile. Two call sites use this, with opposite chrome needs:
 * `VerdictBanner`'s "column" (compare) layout still nests these flush inside
 * its own bordered card (`bordered` omitted/false - a border here would read
 * as a card nested in a card); `OverviewHeader`'s page-layout header sits
 * these directly in the open bento grid, where they need their own visible
 * boundary (`bordered`) to read as distinct tiles at all.
 */
export function KpiTile({
  label,
  value,
  unit,
  sub,
  icon,
  colorVar,
  band,
  delta,
  badges,
  bordered = false,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  sub?: string;
  icon: React.ReactNode;
  colorVar: string;
  band?: ScoreBand;
  delta?: KpiDelta;
  /** Route badges (subway/bus) shown under the sub-label. */
  badges?: React.ReactNode;
  bordered?: boolean;
}) {
  const deltaGood =
    delta && delta.pct !== 0
      ? delta.invert
        ? delta.pct < 0
        : delta.pct > 0
      : null;
  const deltaColor =
    deltaGood === null
      ? "var(--text-muted)"
      : deltaGood
        ? "var(--status-good-ink)"
        : "var(--status-critical-ink)";

  return (
    <div
      className={
        bordered
          ? "flex flex-col gap-2 rounded-lg border border-(--border-hairline) bg-(--surface-1) p-3"
          : "flex flex-col gap-2"
      }
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-(--text-muted)">
          {label}
        </p>
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{
            color: `var(${colorVar}-ink)`,
            background: `color-mix(in srgb, var(${colorVar}) 14%, transparent)`,
          }}
        >
          {icon}
        </span>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="font-data text-xl font-semibold text-(--text-primary)">
          {value}
        </span>
        {unit && <span className="text-xs text-(--text-muted)">{unit}</span>}
      </div>

      {band && <StatusBadge band={band} />}

      {sub && !delta && <p className="text-xs text-(--text-muted)">{sub}</p>}

      {badges && <div className="flex flex-wrap gap-1">{badges}</div>}

      {delta && (
        <p
          className="font-data flex items-center gap-1 text-xs"
          style={{ color: deltaColor }}
        >
          {delta.pct > 0 && <TrendUpIcon className="h-3 w-3" />}
          {delta.pct < 0 && <TrendDownIcon className="h-3 w-3" />}
          {Math.abs(delta.pct).toFixed(0)}% {delta.label}
        </p>
      )}
    </div>
  );
}

/**
 * Its own leaf so the block-complaint trend subscription (and the re-render
 * when it lands) is scoped to this one tile. The subscription costs nothing
 * extra: usePrefetchTrends already warmed this exact key at geocode time, and
 * SWR dedupes against the building/block panels' own useTrend calls.
 */
export function VolumeTile({
  lat,
  lng,
  bordered,
}: {
  lat: number;
  lng: number;
  bordered?: boolean;
}) {
  const { data } = useTrend({ lat, lng }, "block");
  const yoy = yoyDelta(data);

  return (
    <KpiTile
      label="Block complaints"
      value={yoy ? yoy.current.toLocaleString() : "-"}
      sub="last 12 mo"
      icon={<ClockIcon className="h-4.5 w-4.5" />}
      colorVar="--series-block"
      bordered={bordered}
      delta={
        yoy && yoy.pct !== null
          ? { pct: yoy.pct, invert: true, label: "vs prior 12 mo" }
          : undefined
      }
    />
  );
}
