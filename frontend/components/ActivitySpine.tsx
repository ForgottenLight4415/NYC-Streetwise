"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { STATUS_LABEL, STATUS_VAR } from "@/lib/score";
import { monthsAgoISO } from "@/lib/reportMetrics";
import { TREND_WINDOW_OPTIONS, type TrendWindow } from "@/lib/api";
import type { Complaint, ComplaintTierId } from "@/lib/types";
import { ChevronRightIcon } from "./icons";

/*
 * NOTE: this is a chronological FEED of distinct 311 complaints, not a
 * per-case progress timeline. `lib/types.ts` records that a synthesized
 * "Open -> In Progress -> Closed" timeline was deliberately removed because
 * 311 publishes no per-case change log - do not reintroduce that here. Every
 * row below is one complaint's filing date and CURRENT status, nothing more.
 */

const ComplaintDetailModal = dynamic(
  () => import("./ComplaintDetailModal").then((m) => m.ComplaintDetailModal),
  { ssr: false },
);

const ComplaintsBrowserModal = dynamic(
  () =>
    import("./ComplaintsBrowserModal").then((m) => m.ComplaintsBrowserModal),
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
  });
}

const ROWS_SHOWN = 5;

interface TierFeed {
  tier: ComplaintTierId;
  label: string;
  colorVar: string;
  complaints: Complaint[] | undefined;
  isLoading: boolean;
  radiusMeters: number;
  /** The tier's complaint count as shown on its score card. */
  total: number;
}

interface TaggedComplaint extends Complaint {
  tierColorVar: string;
  /** Short form of the tier's full label ("Building Health" -> "Building"),
   *  for the inline row tag below - the full label is too wide for a
   *  compact row next to the date and status. */
  tierTag: string;
}

/** First word of the tier's full category label ("Building Health" ->
 *  "Building", "Block Quality" -> "Block"). Not a lookup table like
 *  RADAR_LABEL in ReportBody: both current tiers happen to have their short
 *  form as their first word already, and a merged feed row has much less
 *  space to spare than a radar axis label. */
function shortTierTag(label: string): string {
  return label.split(" ")[0];
}

/**
 * The report's merged, cross-tier "recent activity" feed - replaces the two
 * separate per-panel "Recent complaints" sections that used to live inside
 * each ScorePanelCard. Both tiers' newest complaints are interleaved here
 * instead, so nothing is listed twice.
 */
/**
 * The feed and its "Browse" links always cover the report's full scoring
 * window (`windowMonths`), not a trend window: the link counts are the score
 * cards' own counts, so the number beside "Browse building health" is the
 * number on the Building Health card. The modal still opens at that window
 * and offers its own window chips from there.
 */
export function ActivitySpine({
  lat,
  lng,
  windowMonths,
  tiers,
}: {
  lat: number;
  lng: number;
  windowMonths: number;
  tiers: TierFeed[];
}) {
  const [selected, setSelected] = useState<Complaint | null>(null);
  const [browsing, setBrowsing] = useState<ComplaintTierId | null>(null);

  const stillLoading = tiers.some(
    (t) => t.complaints === undefined || t.isLoading,
  );

  const cutoff = monthsAgoISO(windowMonths);
  // The modal's window chips offer TREND_WINDOW_OPTIONS only; start it at the
  // report's window when that is one of them, else the widest.
  const modalMonths: TrendWindow =
    TREND_WINDOW_OPTIONS.find((m) => m === windowMonths) ??
    TREND_WINDOW_OPTIONS[TREND_WINDOW_OPTIONS.length - 1];
  const merged: TaggedComplaint[] = useMemo(() => {
    const rows = tiers.flatMap((t) =>
      (t.complaints ?? [])
        .filter((c) => c.date >= cutoff)
        .map((c) => ({
          ...c,
          tierColorVar: t.colorVar,
          tierTag: shortTierTag(t.label),
        })),
    );
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return rows.slice(0, ROWS_SHOWN);
  }, [tiers, cutoff]);

  const browsingTier = tiers.find((t) => t.tier === browsing);

  return (
    <div
      className="flex flex-col gap-3 rounded-lg bg-(--surface-1) p-5 sm:p-6"
      style={{
        boxShadow: "var(--shadow-md)",
        border: "1px solid var(--border-hairline)",
      }}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-(--text-muted)">
        Recent activity
      </p>

      {stillLoading ? (
        <div
          className="h-88 animate-pulse rounded-md"
          style={{ background: "var(--surface-2)" }}
          aria-label="Loading recent activity"
        />
      ) : merged.length === 0 ? (
        <p className="text-sm text-(--text-muted)">
          No complaints in the last {windowMonths} months.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-(--gridline)">
          {merged.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelected(c)}
                className="activity-row flex min-h-11 w-full items-center gap-3 rounded-md py-2 text-left text-sm transition-colors hover:bg-(--surface-2)"
              >
                {/* Color dot + short tier tag on one line, date on the
                    next - a second stacked line, not a wider single line,
                    since a merged feed row (compact already, min-h-11) has
                    little width to spare next to the truncated title. */}
                <span className="flex w-16 shrink-0 flex-col items-start gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: `var(${c.tierColorVar})` }}
                    />
                    <span className="text-[10px] font-semibold text-(--text-secondary)">
                      {c.tierTag}
                    </span>
                  </span>
                  <span className="font-data text-[11px] text-(--text-muted)">
                    {formatDate(c.date)}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <p className="truncate text-(--text-primary)">{c.label}</p>
                  <span
                    className="text-xs"
                    style={{ color: `var(${STATUS_VAR[c.status]}-ink)` }}
                  >
                    {STATUS_LABEL[c.status]}
                  </span>
                </span>
                <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
        {tiers.map((t) => (
          <button
            key={t.tier}
            type="button"
            onClick={() => setBrowsing(t.tier)}
            onPointerEnter={preloadBrowser}
            onFocus={preloadBrowser}
            className="min-h-11 text-xs font-semibold text-(--brand-ink)"
          >
            Browse {t.label.toLowerCase()} ({t.total.toLocaleString()})
          </button>
        ))}
      </div>

      {selected && (
        <ComplaintDetailModal
          complaint={selected}
          onClose={() => setSelected(null)}
        />
      )}

      {browsingTier && (
        <ComplaintsBrowserModal
          lat={lat}
          lng={lng}
          tier={browsingTier.tier}
          radiusMeters={browsingTier.radiusMeters}
          panelLabel={browsingTier.label}
          initialMonths={modalMonths}
          onClose={() => setBrowsing(null)}
        />
      )}
    </div>
  );
}
