import { AMENITY_BUCKET_LABEL } from "@/lib/amenities";
import { computeOverviewMetrics } from "@/lib/reportMetrics";
import { BAND_VAR } from "@/lib/score";
import type { ReportResponse } from "@/lib/types";
import { BuildingIcon, MapPinIcon, TransitIcon } from "./icons";
import { KpiTile, VolumeTile } from "./KpiTile";
import { ScoreRadar, type RadarAxis } from "./ScoreRadar";

/**
 * The right-hand 2/5 of the report page's top split (see ReportBody): the
 * neighborhood radar plus the 4 KPI tiles (Liveability, Access, Block
 * complaints, Nearest Transit) — the pieces `VerdictBanner` used to render
 * inline before its headline/summary half moved out (see VerdictBanner's own
 * doc comment). Page layout only; the compare view keeps everything in
 * VerdictBanner's "column" mode instead.
 *
 * Always stacked (radar above a 2-column KPI grid), never side by side —
 * this now lives in a column that is at most ~2/5 of the main content width,
 * which a `sm:`/`lg:` breakpoint (keyed to the VIEWPORT, not this container)
 * cannot see: a wide-viewport `lg:flex-row` would still fire even though the
 * column itself is narrow, squeezing a 256px radar and 4 KPI tiles into a
 * space meant for neither.
 *
 * No wrapping card around the whole column: each tile is its own small
 * bordered card (`KpiTile`'s `bordered` prop), and `ScoreRadar` is already
 * self-contained, rather than nesting bordered tiles inside one more outer
 * card.
 *
 * Unlike the old inline "Nearest Transit" tile, this one never shows route
 * badges — those stay on the Transit Access amenity card below, which has
 * the room for them. Here the type (Subway/Bus/Commuter rail) is folded into
 * the sub-label as plain text instead.
 */
export function OverviewHeader({
  report,
  coords,
}: {
  report: ReportResponse;
  coords: { lat: number; lng: number };
}) {
  const {
    liveabilityBand,
    liveabilityScore,
    hasAccess,
    accessBand,
    accessScore,
    transitWalk,
    transitName,
    transitBucket,
  } = computeOverviewMetrics(report);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-3">
        <KpiTile
          label="Liveability"
          value={liveabilityScore}
          unit="/100"
          icon={<BuildingIcon className="h-4.5 w-4.5" />}
          colorVar={BAND_VAR[liveabilityBand]}
          band={liveabilityBand}
          bordered
        />

        {hasAccess && accessScore !== null && (
          <KpiTile
            label="Access"
            value={accessScore}
            unit="/100"
            icon={<MapPinIcon className="h-4.5 w-4.5" />}
            colorVar={BAND_VAR[accessBand]}
            band={accessBand}
            bordered
          />
        )}

        <VolumeTile lat={coords.lat} lng={coords.lng} bordered />

        {transitName && transitWalk && (
          <KpiTile
            label="Nearest Transit"
            value={transitWalk}
            sub={
              transitBucket
                ? `${AMENITY_BUCKET_LABEL[transitBucket] ?? transitBucket} · ${transitName}`
                : transitName
            }
            icon={<TransitIcon className="h-4.5 w-4.5" />}
            colorVar="--transit"
            bordered
          />
        )}
      </div>
    </div>
  );
}
