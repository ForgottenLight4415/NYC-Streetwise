"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { STATUS_LABEL, STATUS_VAR } from "@/lib/score";
import type { Complaint } from "@/lib/types";
import type { TrendWindow } from "@/lib/api";
import { ChevronRightIcon } from "./icons";

/* Both modals are click-gated, and neither can be on screen when the report
   first paints — but they were statically imported, so every visitor
   downloaded them to read a score. ComplaintsBrowserModal alone is the largest
   component in the app, and drags in the filter chips, the pager and the whole
   grouped-complaints API surface with it.

   ssr:false because there is nothing to prerender: they only ever exist in
   response to a click. */

const ComplaintDetailModal = dynamic(
  () => import("./ComplaintDetailModal").then((m) => m.ComplaintDetailModal),
  { ssr: false },
);

const ComplaintsBrowserModal = dynamic(
  () => import("./ComplaintsBrowserModal").then((m) => m.ComplaintsBrowserModal),
  { ssr: false },
);

/** Pulls the browser chunk on intent, so the click itself has nothing to wait for. */
function preloadBrowser() {
  void import("./ComplaintsBrowserModal");
}

function formatDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Rows shown inline. The rest live in the browser, which can filter and page. */
const COLLAPSED_COUNT = 5;

export function RecentComplaintsList({
  complaints,
  months,
  /** Exact count for the window, from the aggregated trend series — the
   *  `complaints` array is row-capped and cannot be counted from. */
  windowTotal,
  tier,
  lat,
  lng,
  radiusMeters,
  panelLabel,
}: {
  complaints: Complaint[];
  months: TrendWindow;
  windowTotal: number | null;
  tier: "building" | "block";
  lat: number;
  lng: number;
  radiusMeters: number;
  panelLabel: string;
}) {
  const [selected, setSelected] = useState<Complaint | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const visible = complaints.slice(0, COLLAPSED_COUNT);
  // Offer the browser whenever the window holds more than we are showing. Falls
  // back to the list's own length before the trend series has landed.
  const hasMore = (windowTotal ?? complaints.length) > visible.length;

  return (
    <>
      {complaints.length === 0 ? (
        <p className="text-sm text-(--text-muted)">
          No complaints in the last {months} months.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-(--gridline)">
          {visible.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelected(c)}
                // min-h-11 gives the row a 44px touch target; at py-2.5 a
                // single-line complaint was about 38px.
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md py-2.5 text-left text-sm transition-colors hover:bg-(--surface-2)"
              >
                <div className="min-w-0">
                  <p className="truncate text-(--text-primary)">{c.label}</p>
                  <p className="font-data text-xs text-(--text-muted)">
                    {formatDate(c.date)}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  <span
                    className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs"
                    style={{ color: `var(${STATUS_VAR[c.status]}-ink)` }}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: `var(${STATUS_VAR[c.status]})` }}
                    />
                    {STATUS_LABEL[c.status]}
                  </span>
                  <ChevronRightIcon className="h-3.5 w-3.5 text-(--text-muted)" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="mt-2">
          {/* No truncation caveat here. The rows above are the newest 5 of a
              newest-first list, so they are right even when the 200-row feed
              behind them was capped, and this button opens the grouped browser
              — a different, far larger dataset that carries its own notice when
              it genuinely runs out of history. */}
          <button
            type="button"
            onClick={() => setBrowsing(true)}
            onPointerEnter={preloadBrowser}
            onFocus={preloadBrowser}
            className="min-h-11 text-xs font-semibold text-(--brand-ink)"
          >
            Show all {windowTotal !== null ? windowTotal.toLocaleString() : ""}
          </button>
        </div>
      )}

      {selected && (
        <ComplaintDetailModal
          complaint={selected}
          onClose={() => setSelected(null)}
        />
      )}

      {browsing && (
        <ComplaintsBrowserModal
          lat={lat}
          lng={lng}
          tier={tier}
          radiusMeters={radiusMeters}
          panelLabel={panelLabel}
          initialMonths={months}
          onClose={() => setBrowsing(false)}
        />
      )}
    </>
  );
}
