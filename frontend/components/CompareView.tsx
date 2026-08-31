"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCoords, usePrefetchTrends, useReport } from "@/lib/hooks";
import { CompareAddressField } from "./CompareAddressField";
import { CompareAlignedBody } from "./CompareAlignedBody";
import { CompareColumnContent } from "./CompareColumnContent";

export function CompareView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const a = searchParams.get("a") ?? "";
  const b = searchParams.get("b") ?? "";

  function updateParam(key: "a" | "b", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`/compare?${params.toString()}`);
  }

  // Same two hooks the report page uses, so comparing an address you already
  // looked up costs nothing — and comparing an address against ITSELF issues
  // one request, not two. Fetched here (not inside each column) because
  // deciding whether to render the row-aligned layout below needs both
  // results up front.
  const { data: coordsA, error: coordsErrorA } = useCoords(a);
  const { data: reportA, error: reportErrorA } = useReport(coordsA);
  const { data: coordsB, error: coordsErrorB } = useCoords(b);
  const { data: reportB, error: reportErrorB } = useReport(coordsB);
  usePrefetchTrends(coordsA);
  usePrefetchTrends(coordsB);

  const bothReady = !!(reportA && coordsA && reportB && coordsB);

  return (
    <div id="main" className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-(--text-primary)">
        Compare two addresses
      </h1>
      <p className="mt-1 text-sm text-(--text-secondary)">
        Side-by-side building and block scores to help you pick between options.
      </p>

      {/* The address fields always render in this simple 2-up grid, whether
          or not either report has loaded yet — only the content below
          switches layout. Two of them only fit from lg up; below that they
          stack, which on a phone reads as A then B rather than as a
          comparison — the honest tradeoff, since a 160px-wide score panel
          would not be readable either.

          max-w-screen-2xl (widened from max-w-6xl, matching the report
          page) and a tighter gap-6/lg:gap-4 (down from gap-10/lg:gap-8):
          the report page's panels are now `compact` and denser, so two
          columns of them no longer need as much breathing room between them
          to read as separate reports rather than one merged grid — and the
          extra width goes straight to the columns themselves, which is what
          actually needed it now that each one renders a merged verdict
          panel plus a KPI grid. */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2 lg:gap-4">
        <CompareAddressField
          label="Address A"
          initialAddress={a}
          onAddressChange={(v) => updateParam("a", v)}
        />
        <CompareAddressField
          label="Address B"
          initialAddress={b}
          onAddressChange={(v) => updateParam("b", v)}
        />
      </div>

      <div className="mt-4">
        {bothReady ? (
          // Both sides loaded: render every section as a shared row so
          // matching cards line up and match height between the two
          // addresses — see CompareAlignedBody's own doc for how.
          <CompareAlignedBody
            a={{ address: a, coords: coordsA, report: reportA }}
            b={{ address: b, coords: coordsB, report: reportB }}
          />
        ) : (
          // At least one side isn't loaded yet — nothing to align a loaded
          // report against, so each column just shows whatever it has
          // (placeholder, spinner, error, or its own full report)
          // independently, same as before this layout existed.
          <div className="grid gap-6 lg:grid-cols-2 lg:gap-4">
            <CompareColumnContent
              address={a}
              coords={coordsA}
              report={reportA}
              error={coordsErrorA ?? reportErrorA}
            />
            <CompareColumnContent
              address={b}
              coords={coordsB}
              report={reportB}
              error={coordsErrorB ?? reportErrorB}
            />
          </div>
        )}
      </div>
    </div>
  );
}
