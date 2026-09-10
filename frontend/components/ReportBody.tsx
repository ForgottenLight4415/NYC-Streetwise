"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { COMPLAINT_CATEGORIES } from "@/lib/categories";
import { AMENITY_BUCKET_LABEL } from "@/lib/amenities";
import { type useReportPanels } from "@/lib/hooks";
import type { CategoryKey, ReportResponse } from "@/lib/types";
import { ActivitySpine } from "./ActivitySpine";
import { AmenityPanelCard } from "./AmenityPanelCard";
import { CATEGORY_ICONS } from "./categoryIcons";
import { MapPanelLazy } from "./MapPanelLazy";
import { OverviewHeader } from "./OverviewHeader";
import { ReportToolbar } from "./ReportToolbar";
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

type Panels = ReturnType<typeof useReportPanels>;

/**
 * Amenity grid columns, keyed by how many amenity sections a report actually
 * has - 4 today (transit/parks/bike/walkability). A static lookup rather
 * than a template string: Tailwind only sees literal class names in source,
 * so `md:grid-cols-${n}` would not be in the build's CSS at all.
 *
 * 3 jumps straight from 1 column to 3 at `md`, with no `md:grid-cols-2` stop
 * - a 2-column grid holding 3 cards orphans the third in its own half-width
 * row. 2 and 4 divide evenly into 2 columns, so they keep that stop. Kept
 * even though nothing currently produces exactly 3 (a partial amenity
 * failure can still land here - see ReportResponse's optional fields).
 *
 * The 4-column stop is `lg`, not `xl` (lowered from xl): these are `compact`
 * PanelShell cards (small score chip, no 96px meter, p-4 padding), and once
 * the page layout below gains its own `xl:` right rail for ActivitySpine,
 * the main column actually gets NARROWER at `xl`, not wider - asking for a
 * 4th column at exactly the breakpoint where the column shrinks would
 * compound the squeeze. At `lg` (1024px, no rail yet since that needs `xl`),
 * the full-width main column is ~976px; four compact cards in a gap-4 grid
 * land at ~232px each, comfortably more than the ~188px they'd get if this
 * stayed at `xl` with the rail active.
 */
const AMENITY_COLS: Record<number, string> = {
  1: "",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-2 lg:grid-cols-4",
};

export function CategoryIcon({
  category,
  className,
}: {
  category: CategoryKey;
  className?: string;
}) {
  const Icon = CATEGORY_ICONS[category];
  return <Icon className={className} />;
}

/**
 * Everything below the address bar on both the report page and one compare
 * column - extracted because those two were already near-identical before
 * amenities existed, and every category added below would otherwise be
 * edited in two places instead of one.
 *
 * `layout` picks the arrangement: "page" gets the sticky toolbar and a wide
 * two-column shell - a main column carrying the toolbar, a 5-column split
 * (the AI summary banner at 3/5, the radar + KPI tiles at 2/5), the
 * complaint and amenity cards, plus a right rail holding the cross-tier
 * activity feed followed by the map, sticky once the viewport is wide enough
 * to show both side by side. "column" (the compare view) stacks everything
 * in one column - verdict banner, cards, radar, map - and renders no
 * activity feed at all, since the compare view fetches no complaint feeds to
 * fill one with.
 *
 * `panels` is optional - the compare view passes neither complaint feeds nor
 * anything else, which is exactly how it already hides the activity feed
 * (see below) and skips the AI summary fetch (see VerdictBanner) - and, as a
 * side effect of both cards reading from the same registry, the compare view
 * gains the amenity scores and the radar for free.
 *
 * The trend window used to live inside each ScorePanelCard independently.
 * It is lifted here so ONE control (the toolbar's, or this component's own
 * for the column layout) scopes both complaint panels and the activity feed
 * together. `useDeferredValue` - not a state update wrapped in
 * `startTransition` - keeps the selected pill's own highlight instantaneous
 * while the two sparklines and the feed re-slice behind it.
 */
export function ReportBody({
  report,
  coords,
  address,
  layout,
  panels,
}: {
  report: ReportResponse;
  coords: { lat: number; lng: number };
  address: string;
  layout: "page" | "column";
  panels?: Panels;
}) {
  const {
    months,
    setMonths,
    deferredMonths,
    openAmenity,
    setOpenAmenity,
    extraMarkers,
    amenityCats,
    rings,
    radarAxes,
    showRadar,
  } = useReportPanelState(report, coords);

  // Page layout only: Transit Access joins Building/Block in one top row
  // (see OverviewHeader's doc comment for why the radar+KPI header moved up
  // here too) instead of sitting in the amenity grid with parks/bike/walk -
  // that grid drops from 4 columns to 3, giving every remaining card (and
  // the badge-heavy transit card above) more width. The "column" (compare)
  // layout is unaffected: it keeps all four amenity categories together,
  // unchanged.
  const transitCat = amenityCats.find((c) => c.key === "transitAccess");
  const otherAmenityCats =
    layout === "page"
      ? amenityCats.filter((c) => c.key !== "transitAccess")
      : amenityCats;

  // lg, not md, for the complaint cards, even though `compact` removes the
  // 96px meter that used to justify `lg`: the meter was never what collided
  // at 640px (see the original note this comment replaces) - the sparkline
  // below it did, because TrendSparkline's fixed-size HTML date labels sit
  // under an SVG whose 320-unit viewBox scales down with the card. Card
  // width is set by the grid's column count alone, not by the header's
  // content, so shrinking the header doesn't hand the sparkline any more
  // room by itself.
  //
  // What DOES help is `compact`'s tighter padding (p-4 instead of p-5/
  // sm:p-6). At `md` (768px) the container is 768 - 48px page padding = 720;
  // two columns at gap-4 give 352px per card; compact's p-4 (32px total)
  // leaves 320px of content width - which is exactly TrendSparkline's
  // native 320-unit design width, i.e. the sparkline renders at its
  // intended scale, not shrunk. The same card at the OLD p-5/sm:p-6 padding
  // (~40-48px) would leave only ~272-280px, close enough to the documented
  // 288px sm-breakpoint collision to risk repeating it. So: lowered to `md`,
  // but only because `compact` is now always on for these cards - if that
  // ever changes, this needs to move back to `lg`.
  const topRowCount = COMPLAINT_CATEGORIES.length + (transitCat ? 1 : 0);
  const complaintGridClass =
    layout === "page"
      ? `mt-4 grid gap-4 ${AMENITY_COLS[topRowCount] ?? "md:grid-cols-2"}`
      : "mt-4 flex flex-col gap-4";
  const amenityGridClass =
    layout === "page"
      ? `mt-4 grid gap-4 ${AMENITY_COLS[otherAmenityCats.length] ?? "md:grid-cols-2"}`
      : "mt-4 flex flex-col gap-4";

  // panels itself is a fresh object literal every render (useReportPanels has
  // no memoization of its own), so it can't be the useMemo dep either -
  // depend on the actual stable pieces nested inside it instead: `data` is
  // an SWR cache array (stable when unchanged), the rest are primitives.
  // Same "primitive/stable-key, not raw-object" trick as MapPanel's
  // ringsKey/extraMarkersKey and ComplaintsBrowserModal's requestKey.
  // Otherwise ActivitySpine's own [tiers, cutoff] useMemo recomputes its
  // flat-map/filter/sort on every unrelated ReportBody re-render (trend-pill
  // clicks, amenity-modal toggles).
  const hasPanels = !!panels;
  const buildingComplaints = panels?.buildingHealth.complaints;
  const blockComplaints = panels?.blockQuality.complaints;
  const activityTiers = useMemo(
    () =>
      panels
        ? COMPLAINT_CATEGORIES.map((c) => ({
            tier: c.id,
            label: c.label,
            colorVar: c.colorVar,
            complaints: panels[c.key].complaints?.data,
            isLoading: panels[c.key].complaints?.isLoading ?? false,
            radiusMeters: report[c.key].radiusMeters,
          }))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      hasPanels,
      buildingComplaints?.data,
      buildingComplaints?.isLoading,
      blockComplaints?.data,
      blockComplaints?.isLoading,
      report.buildingHealth.radiusMeters,
      report.blockQuality.radiusMeters,
    ],
  );

  const mainColumn = (
    <div className="min-w-0">
      {layout === "page" && (
        <ReportToolbar
          address={address}
          months={months}
          onMonthsChange={setMonths}
        />
      )}

      {layout === "page" ? (
        // A 5-column split: the AI summary banner is the thing worth the most
        // reading room (3/5), the radar + KPI tiles are glanceable numbers
        // that need less (2/5). Stacks to one column below `lg` rather than
        // squeezing both into a narrow phone width.
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <VerdictBanner
              report={report}
              panels={panels}
              coords={coords}
              address={address}
              windowMonths={report.meta.windowMonths}
              // ReportToolbar above already carries the address heading.
              showAddress={false}
              layout="page"
            />
          </div>
          <div className="lg:col-span-2">
            {showRadar && <ScoreRadar axes={radarAxes} />}
          </div>
        </div>
      ) : (
        <VerdictBanner
          report={report}
          panels={panels}
          coords={coords}
          address={address}
          windowMonths={report.meta.windowMonths}
          showAddress
          layout={layout}
        />
      )}

      <div className="mt-4">
        <OverviewHeader report={report} coords={coords} />
      </div>

      {layout === "column" && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-(--text-muted)">
            Trend window
          </p>
          <WindowPills
            months={months}
            onMonthsChange={setMonths}
            ariaLabel="Trend window"
          />
        </div>
      )}

      <div className={complaintGridClass}>
        {COMPLAINT_CATEGORIES.map((c) => {
          const section = report[c.key];
          return (
            <ScorePanelCard
              key={c.key}
              icon={<CategoryIcon category={c.key} className="h-4.5 w-4.5" />}
              title={c.label}
              panel={section}
              colorVar={c.colorVar}
              description={c.description}
              tier={c.id}
              lat={coords.lat}
              lng={coords.lng}
              months={deferredMonths}
              compact
            />
          );
        })}
        {/* Page layout only - see the `transitCat`/`otherAmenityCats` split
            above. Column layout keeps transit in the amenity grid below via
            `otherAmenityCats`, so rendering it here too would duplicate it. */}
        {layout === "page" && transitCat && (
          <AmenityPanelCard
            icon={
              <CategoryIcon category={transitCat.key} className="h-4.5 w-4.5" />
            }
            title={transitCat.label}
            description={transitCat.description}
            colorVar={transitCat.colorVar}
            panel={report[transitCat.key]!}
            onOpenBucket={(bucket) =>
              setOpenAmenity({
                tier: transitCat.id,
                bucket,
                colorVar: transitCat.colorVar,
                label: AMENITY_BUCKET_LABEL[bucket] ?? bucket,
              })
            }
            onHoverBucket={preloadAmenityBrowser}
          />
        )}
      </div>

      {/* No md:grid-cols-2 hardcode on the page layout - AMENITY_COLS keys
          the column count off how many amenity sections actually exist, so
          three items never leave an orphan hole in a two-column grid, and a
          fourth (walkability) grows the grid instead of needing an edit here. */}
      {otherAmenityCats.length > 0 && (
        <div className={amenityGridClass}>
          {otherAmenityCats.map((c) => (
            <AmenityPanelCard
              key={c.key}
              icon={<CategoryIcon category={c.key} className="h-4.5 w-4.5" />}
              title={c.label}
              description={c.description}
              colorVar={c.colorVar}
              panel={report[c.key]!}
              onOpenBucket={(bucket) =>
                setOpenAmenity({
                  tier: c.id,
                  bucket,
                  colorVar: c.colorVar,
                  label: AMENITY_BUCKET_LABEL[bucket] ?? bucket,
                })
              }
              onHoverBucket={preloadAmenityBrowser}
            />
          ))}
        </div>
      )}

      {layout === "column" && showRadar && (
        <div className="mt-4">
          <ScoreRadar axes={radarAxes} />
        </div>
      )}

      {/* Page layout moves the map (and the modal it can open) into the xl
          right rail, below the activity feed - see the rail block below.
          Only the compare ("column") layout, which has no rail, keeps them
          here. */}
      {layout === "column" && (
        <div className="mt-4">
          <MapPanelLazy
            centerLat={coords.lat}
            centerLng={coords.lng}
            rings={rings}
            extraMarkers={extraMarkers}
            extraMarkersColorVar={openAmenity?.colorVar}
          />
        </div>
      )}

      {layout === "column" && openAmenity && (
        <AmenityBrowserModal
          lat={coords.lat}
          lng={coords.lng}
          tier={openAmenity.tier}
          bucket={openAmenity.bucket}
          bucketLabel={openAmenity.label}
          onClose={() => setOpenAmenity(null)}
        />
      )}
    </div>
  );

  if (layout === "column" || !activityTiers) {
    // Compare view: no right rail, no activity feed - unchanged from before
    // this pass. The compare view fetches no complaint feeds, so there is
    // nothing to fill an activity feed with; that stays out of scope here.
    return mainColumn;
  }

  return (
    <div className="xl:grid xl:grid-cols-[1fr_360px] xl:items-start xl:gap-6">
      {mainColumn}

      {/* The activity feed used to live in a bento row paired with the
          radar; it's pulled out to its own right rail here so it reads as
          a persistent "what's new nearby" panel rather than one more grid
          item. `xl`, not `lg`: below that there isn't room for a useful
          360px-plus column beside the main content without squeezing the
          complaint/amenity grids, which still need the full-width column
          at `lg` (see AMENITY_COLS and complaintGridClass above) - so below
          `xl` this stacks full width after the map instead, exactly like
          the old bento row did on narrower viewports.

          `top-20` (5rem): ReportToolbar sticks at `top-16` (4rem), matching
          the app header's height. Sticking the rail at that exact same
          offset would still avoid overlap on its own - they're side by
          side, not stacked - but it would also pin this panel's top edge
          level with the toolbar's top edge rather than its bottom, which
          reads as misaligned once both are stuck mid-scroll. The extra 1rem
          settles the rail just below the toolbar's row instead.

          The AI summary banner (VerdictBanner) no longer lives in this rail -
          it moved into the main column's top 5-column split, alongside
          OverviewHeader's radar (see above) - so this rail is just "what's
          changed lately" (ActivitySpine) followed by the map. */}
      <div className="mt-4 flex flex-col gap-4 xl:sticky xl:top-20 xl:mt-0">
        <ActivitySpine
          lat={coords.lat}
          lng={coords.lng}
          months={deferredMonths}
          tiers={activityTiers}
        />

        <MapPanelLazy
          centerLat={coords.lat}
          centerLng={coords.lng}
          rings={rings}
          extraMarkers={extraMarkers}
          extraMarkersColorVar={openAmenity?.colorVar}
        />

        {openAmenity && (
          <AmenityBrowserModal
            lat={coords.lat}
            lng={coords.lng}
            tier={openAmenity.tier}
            bucket={openAmenity.bucket}
            bucketLabel={openAmenity.label}
            onClose={() => setOpenAmenity(null)}
          />
        )}
      </div>
    </div>
  );
}
