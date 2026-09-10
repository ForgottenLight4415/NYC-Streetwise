"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { AMENITY_BUCKET_LABEL } from "@/lib/amenities";
import { AMENITY_CATEGORIES, COMPLAINT_CATEGORIES } from "@/lib/categories";
import type { ReportResponse } from "@/lib/types";
import { AmenityPanelCard } from "./AmenityPanelCard";
import { CategoryIcon } from "./ReportBody";
import { MapPanelLazy } from "./MapPanelLazy";
import { OverviewHeader } from "./OverviewHeader";
import { ScoreRadar } from "./ScoreRadar";
import { ScorePanelCard } from "./ScorePanelCard";
import { useReportPanelState } from "./useReportPanelState";
import { VerdictBanner } from "./VerdictBanner";
import { WindowPills } from "./WindowPills";

const AmenityBrowserModal = dynamic(
  () => import("./AmenityBrowserModal").then((m) => m.AmenityBrowserModal),
  { ssr: false },
);

/** Pulls the modal chunk on intent, so the click itself has nothing to wait for. */
function preloadAmenityBrowser() {
  void import("./AmenityBrowserModal");
}

/**
 * Total row count below - a compile-time constant, not derived from either
 * report. See the component doc for why that's safe: every row in the list
 * always exists for both sides, so the row COUNT never depends on what a
 * particular report contains, only whether an individual cell renders
 * something or stays empty.
 */
const ROW_COUNT =
  3 /* verdict banner, overview tiles, trend-window pills */ +
  COMPLAINT_CATEGORIES.length +
  AMENITY_CATEGORIES.length +
  2; /* radar, map */

type Side = {
  address: string;
  coords: { lat: number; lng: number };
  report: ReportResponse;
};

/**
 * The compare page's "both addresses loaded" layout: the verdict banner,
 * overview tiles, each complaint card, each amenity card, the radar, and the
 * map each render as their own CSS grid row shared by column A and column B,
 * so a taller card on one side pushes both cells in that row to match height
 * - and the next row still starts level. `CompareColumnContent` (used while
 * at least one side isn't loaded yet) can't do this: there's nothing on the
 * other side yet to align a loaded report against.
 *
 * The trick is `grid-auto-flow: column` (`lg:grid-flow-col`) over a DOM order
 * that is NOT interleaved - every one of A's rows first, then every one of
 * B's, the same order `ReportBody`'s own "column" layout already renders
 * each side in. With an explicit `grid-template-rows` of exactly `ROW_COUNT`
 * tracks and two explicit columns, column-flow placement fills column 1 with
 * all of A's rows before moving to column 2 for B's - so row *i* ends up
 * holding (A's row i, B's row i) without either side's markup needing to
 * know the other exists. Below `lg` there is one column, so that same DOM
 * order reads as "all of A, then all of B" - unchanged from how the compare
 * page has always stacked on a phone (see CompareView's doc comment).
 *
 * A report missing one amenity dataset (a partial server-side failure) - or,
 * in principle, not showing a radar - renders that side's cell empty rather
 * than skipping the row, which would desync every row after it between the
 * two columns.
 */
export function CompareAlignedBody({ a, b }: { a: Side; b: Side }) {
  const panelsA = useReportPanelState(a.report, a.coords);
  const panelsB = useReportPanelState(b.report, b.coords);

  const left: ReactNode[] = [];
  const right: ReactNode[] = [];

  left.push(
    <VerdictBanner
      key="a-banner"
      report={a.report}
      coords={a.coords}
      address={a.address}
      windowMonths={a.report.meta.windowMonths}
      showAddress
      layout="column"
    />,
  );
  right.push(
    <VerdictBanner
      key="b-banner"
      report={b.report}
      coords={b.coords}
      address={b.address}
      windowMonths={b.report.meta.windowMonths}
      showAddress
      layout="column"
    />,
  );

  left.push(
    <OverviewHeader key="a-overview" report={a.report} coords={a.coords} />,
  );
  right.push(
    <OverviewHeader key="b-overview" report={b.report} coords={b.coords} />,
  );

  const windowPillsRow = (
    side: "a" | "b",
    months: typeof panelsA.months,
    onMonthsChange: typeof panelsA.setMonths,
  ) => (
    <div
      key={`${side}-pills`}
      className="flex items-center justify-between gap-3"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-(--text-muted)">
        Trend window
      </p>
      <WindowPills
        months={months}
        onMonthsChange={onMonthsChange}
        ariaLabel="Trend window"
      />
    </div>
  );
  left.push(windowPillsRow("a", panelsA.months, panelsA.setMonths));
  right.push(windowPillsRow("b", panelsB.months, panelsB.setMonths));

  for (const c of COMPLAINT_CATEGORIES) {
    left.push(
      <ScorePanelCard
        key={`a-${c.key}`}
        icon={<CategoryIcon category={c.key} className="h-4.5 w-4.5" />}
        title={c.label}
        panel={a.report[c.key]}
        colorVar={c.colorVar}
        description={c.description}
        tier={c.id}
        lat={a.coords.lat}
        lng={a.coords.lng}
        months={panelsA.deferredMonths}
        compact
      />,
    );
    right.push(
      <ScorePanelCard
        key={`b-${c.key}`}
        icon={<CategoryIcon category={c.key} className="h-4.5 w-4.5" />}
        title={c.label}
        panel={b.report[c.key]}
        colorVar={c.colorVar}
        description={c.description}
        tier={c.id}
        lat={b.coords.lat}
        lng={b.coords.lng}
        months={panelsB.deferredMonths}
        compact
      />,
    );
  }

  for (const c of AMENITY_CATEGORIES) {
    const sectionA = a.report[c.key];
    left.push(
      sectionA ? (
        <AmenityPanelCard
          key={`a-${c.key}`}
          icon={<CategoryIcon category={c.key} className="h-4.5 w-4.5" />}
          title={c.label}
          description={c.description}
          colorVar={c.colorVar}
          panel={sectionA}
          onOpenBucket={(bucket) =>
            panelsA.setOpenAmenity({
              tier: c.id,
              bucket,
              colorVar: c.colorVar,
              label: AMENITY_BUCKET_LABEL[bucket] ?? bucket,
            })
          }
          onHoverBucket={preloadAmenityBrowser}
        />
      ) : (
        <div key={`a-${c.key}`} />
      ),
    );

    const sectionB = b.report[c.key];
    right.push(
      sectionB ? (
        <AmenityPanelCard
          key={`b-${c.key}`}
          icon={<CategoryIcon category={c.key} className="h-4.5 w-4.5" />}
          title={c.label}
          description={c.description}
          colorVar={c.colorVar}
          panel={sectionB}
          onOpenBucket={(bucket) =>
            panelsB.setOpenAmenity({
              tier: c.id,
              bucket,
              colorVar: c.colorVar,
              label: AMENITY_BUCKET_LABEL[bucket] ?? bucket,
            })
          }
          onHoverBucket={preloadAmenityBrowser}
        />
      ) : (
        <div key={`b-${c.key}`} />
      ),
    );
  }

  left.push(
    panelsA.showRadar ? (
      <ScoreRadar key="a-radar" axes={panelsA.radarAxes} />
    ) : (
      <div key="a-radar" />
    ),
  );
  right.push(
    panelsB.showRadar ? (
      <ScoreRadar key="b-radar" axes={panelsB.radarAxes} />
    ) : (
      <div key="b-radar" />
    ),
  );

  left.push(
    <MapPanelLazy
      key="a-map"
      centerLat={a.coords.lat}
      centerLng={a.coords.lng}
      rings={panelsA.rings}
      extraMarkers={panelsA.extraMarkers}
      extraMarkersColorVar={panelsA.openAmenity?.colorVar}
    />,
  );
  right.push(
    <MapPanelLazy
      key="b-map"
      centerLat={b.coords.lat}
      centerLng={b.coords.lng}
      rings={panelsB.rings}
      extraMarkers={panelsB.extraMarkers}
      extraMarkersColorVar={panelsB.openAmenity?.colorVar}
    />,
  );

  return (
    <>
      <div
        className="grid grid-cols-1 gap-y-4 lg:grid-cols-2 lg:grid-flow-col lg:gap-x-4"
        style={{ gridTemplateRows: `repeat(${ROW_COUNT}, auto)` }}
      >
        {left}
        {right}
      </div>

      {panelsA.openAmenity && (
        <AmenityBrowserModal
          lat={a.coords.lat}
          lng={a.coords.lng}
          tier={panelsA.openAmenity.tier}
          bucket={panelsA.openAmenity.bucket}
          bucketLabel={panelsA.openAmenity.label}
          onClose={() => panelsA.setOpenAmenity(null)}
        />
      )}
      {panelsB.openAmenity && (
        <AmenityBrowserModal
          lat={b.coords.lat}
          lng={b.coords.lng}
          tier={panelsB.openAmenity.tier}
          bucket={panelsB.openAmenity.bucket}
          bucketLabel={panelsB.openAmenity.label}
          onClose={() => panelsB.setOpenAmenity(null)}
        />
      )}
    </>
  );
}
