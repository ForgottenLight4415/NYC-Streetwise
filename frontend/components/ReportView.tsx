"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  useCoords,
  usePrefetchTrends,
  useReport,
  useReportPanels,
} from "@/lib/hooks";
import { ReportBody } from "./ReportBody";
import { ReportLoading } from "./ReportLoading";

export function ReportView() {
  const searchParams = useSearchParams();
  const address = searchParams.get("address") ?? "";
  const placeId = searchParams.get("placeId") ?? undefined;

  // Independent subscriptions where there used to be one effect awaiting
  // everything in series. The old order was:
  //
  //     geocode -> /api/score -> every complaint fetch -> RENDER -> trend
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

  // The report's one fixed-arity fanout - every complaint tier's own feed,
  // in one hook. See useReportPanels for why this can't be a loop over the
  // category registry.
  const panels = useReportPanels(coords, report);

  const error = coordsError ?? reportError;

  if (!address) {
    return (
      <main
        id="main"
        className="mx-auto max-w-lg px-4 py-24 text-center sm:px-6"
      >
        <h1 className="sr-only">Address report</h1>
        <p className="text-(--text-secondary)">
          Enter an address above to see its report.
        </p>
      </main>
    );
  }

  if (error) {
    return (
      <main
        id="main"
        className="mx-auto max-w-lg px-4 py-24 text-center sm:px-6"
      >
        <h1 className="sr-only">Address report</h1>
        <p style={{ color: "var(--status-critical)" }}>
          {error instanceof Error ? error.message : "Something went wrong"}
        </p>
        <Link
          href="/"
          className="mt-3 inline-block text-sm underline text-(--text-secondary)"
        >
          Back to search
        </Link>
      </main>
    );
  }

  if (!report || !coords) {
    // The same view the Suspense boundary above already rendered, so the two
    // back-to-back waits read as one. This now covers only the geocode and
    // /api/score - the complaint fetches it used to include have moved into the
    // panels, which render their own skeletons.
    return <ReportLoading />;
  }

  return (
    <main id="main" className="mx-auto max-w-[1920px] px-4 pt-4 pb-8 sm:px-6">
      <ReportBody
        report={report}
        coords={coords}
        address={address}
        layout="page"
        panels={panels}
      />
    </main>
  );
}
