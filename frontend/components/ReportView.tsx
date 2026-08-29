"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  useCoords,
  useExplanation,
  useNearbyComplaints,
  usePrefetchTrends,
  useReport,
} from "@/lib/hooks";
import { AddressSearch } from "./AddressSearch";
import { MapPanelLazy } from "./MapPanelLazy";
import { ReportLoading } from "./ReportLoading";
import { ScorePanelCard } from "./ScorePanelCard";
import { VerdictBanner, type AiExplanationState } from "./VerdictBanner";
import { BuildingIcon, BlockIcon, ChevronRightIcon } from "./icons";

export function ReportView() {
  const searchParams = useSearchParams();
  const address = searchParams.get("address") ?? "";
  const placeId = searchParams.get("placeId") ?? undefined;

  // Four independent subscriptions where there used to be one effect awaiting
  // everything in series. The old order was:
  //
  //     geocode -> /api/score -> both complaint fetches -> RENDER -> trend
  //
  // and nothing at all was on screen until the last of those resolved, even
  // though the complaint lists fill the BOTTOM of each panel. Now:
  //
  //     geocode -> /api/score -> RENDER
  //                          |-> complaints (per tier) -> fills the list
  //                          '-> trend (prefetched at geocode) -> fills the chart
  //
  // The scores paint a full round-trip earlier, and the trend no longer waits
  // on a score it does not depend on.
  const { data: coords, error: coordsError } = useCoords(address, placeId);
  const { data: report, error: reportError } = useReport(coords);

  usePrefetchTrends(coords);

  const buildingComplaints = useNearbyComplaints(
    coords,
    report?.buildingHealth.radiusMeters,
    "building",
  );
  const blockComplaints = useNearbyComplaints(
    coords,
    report?.blockQuality.radiusMeters,
    "block",
  );

  const buildingAi = useExplanation(coords, "building", report?.buildingHealth);
  const blockAi = useExplanation(coords, "block", report?.blockQuality);

  const error = coordsError ?? reportError;

  const aiExplanation = useMemo<AiExplanationState>(() => {
    if (!report) return { loading: false, tiers: [] };
    // Either tier still in flight keeps the banner on "Reasoning...". A tier the
    // backend already had cached never starts a request, so the fully-cached
    // case resolves immediately with no flash.
    if (buildingAi.isLoading || blockAi.isLoading) {
      return { loading: true, tiers: [] };
    }

    const tiers = [
      { label: "Building Health", ai: buildingAi.text, section: report.buildingHealth },
      { label: "Block Quality", ai: blockAi.text, section: report.blockQuality },
    ];

    return {
      loading: false,
      tiers: tiers
        .map(({ label, ai, section }) => ({
          label,
          // Falling back to the tier's own template text rather than dropping
          // the line: a tier with zero complaints legitimately has nothing for
          // the model to describe (see explain.js), and "no complaints were
          // filed" is the accurate thing to say, not an absence worth hiding.
          text: ai ?? section.explanation,
          source: ai ? ("ai" as const) : ("template" as const),
        }))
        .filter((t) => t.text.trim()),
    };
  }, [report, buildingAi.text, buildingAi.isLoading, blockAi.text, blockAi.isLoading]);

  if (!address) {
    return (
      <div className="mx-auto max-w-lg px-4 py-24 text-center sm:px-6">
        <p className="text-(--text-secondary)">
          Enter an address to see its report.
        </p>
        <div className="mt-4">
          <AddressSearch size="sm" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-lg px-4 py-24 text-center sm:px-6">
        <p style={{ color: "var(--status-critical)" }}>
          {error instanceof Error ? error.message : "Something went wrong"}
        </p>
        <Link
          href="/"
          className="mt-3 inline-block text-sm underline text-(--text-secondary)"
        >
          Back to search
        </Link>
      </div>
    );
  }

  if (!report || !coords) {
    // The same view the Suspense boundary above already rendered, so the two
    // back-to-back waits read as one. This now covers only the geocode and
    // /api/score — the complaint fetches it used to include have moved into the
    // panels, which render their own skeletons.
    return <ReportLoading />;
  }

  return (
    <div id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <nav className="mb-5 flex items-center gap-1 text-xs text-(--text-muted)">
        <Link href="/" className="hover:text-(--text-primary)">
          Search
        </Link>
        <ChevronRightIcon className="h-3 w-3" />
        <span className="text-(--text-secondary)">Report</span>
      </nav>

      {/* Stacked on a phone: side by side, the field was squeezed to about
          140px once the Compare button took its width, which is too narrow to
          read a NYC address in. */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 sm:max-w-md">
          <AddressSearch key={address} size="sm" initialValue={address} />
        </div>
        <Link
          href={`/compare?a=${encodeURIComponent(address)}`}
          className="inline-flex h-11 shrink-0 items-center justify-center rounded-full px-5 text-sm font-semibold transition-colors"
          style={{ background: "var(--brand)", color: "#ffffff" }}
        >
          Compare with another
        </Link>
      </div>

      <VerdictBanner
        building={report.buildingHealth}
        block={report.blockQuality}
        address={address}
        windowMonths={report.meta.windowMonths}
        aiExplanation={aiExplanation}
      />

      {/* lg, not sm: at 640px two of these panels — meter, category list,
          sparkline and complaint list each — are about 290px wide, and the
          sparkline axis labels collide. */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ScorePanelCard
          icon={<BuildingIcon className="h-4.5 w-4.5" />}
          title="Building Health"
          panel={report.buildingHealth}
          colorVar="--series-building"
          description="Complaints tied to this building"
          tier="building"
          lat={coords.lat}
          lng={coords.lng}
          recentComplaints={buildingComplaints.data}
          recentComplaintsLoading={buildingComplaints.isLoading}
        />
        <ScorePanelCard
          icon={<BlockIcon className="h-4.5 w-4.5" />}
          title="Block Quality"
          panel={report.blockQuality}
          colorVar="--series-block"
          description="Complaints on the surrounding block"
          tier="block"
          lat={coords.lat}
          lng={coords.lng}
          recentComplaints={blockComplaints.data}
          recentComplaintsLoading={blockComplaints.isLoading}
        />
      </div>

      <div className="mt-4">
        <MapPanelLazy
          centerLat={coords.lat}
          centerLng={coords.lng}
          buildingRadiusMeters={report.buildingHealth.radiusMeters}
          blockRadiusMeters={report.blockQuality.radiusMeters}
        />
      </div>
    </div>
  );
}
