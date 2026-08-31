"use client";

import { useEffect, useState } from "react";
import {
  COMPLAINT_STATUS_OPTIONS,
  TREND_WINDOW_OPTIONS,
  fetchComplaintGroups,
  fetchGroupDetail,
  fetchNearbyComplaints,
  type TrendWindow,
} from "@/lib/api";
import { formatDistance } from "@/lib/amenities";
import { CATEGORY_LABEL, STATUS_LABEL, STATUS_VAR } from "@/lib/score";
import { useDialog } from "@/lib/useDialog";
import type {
  Complaint,
  ComplaintGroup,
  ComplaintStatus,
  ComplaintTierId,
} from "@/lib/types";
import { ChevronRightIcon, CloseIcon } from "./icons";
import { ComplaintDetailModal } from "./ComplaintDetailModal";
import { FactRotator } from "./FactRotator";
import { FilterChips } from "./FilterChips";
import { Pager } from "./Pager";
import { Portal } from "./Portal";

/** The buckets each tier actually has, so the type filter never offers an empty one. */
const TIER_BUCKETS = {
  building: ["heatHotWater", "unsanitaryCondition", "plumbing"],
  block: ["noise", "parking", "streetCondition"],
} as const;

function formatDay(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface DrillIn {
  group: ComplaintGroup;
  items: Complaint[] | null;
  total: number;
  offset: number;
}

export function ComplaintsBrowserModal({
  lat,
  lng,
  tier,
  radiusMeters,
  panelLabel,
  initialMonths,
  onClose,
}: {
  lat: number;
  lng: number;
  tier: ComplaintTierId;
  radiusMeters: number;
  panelLabel: string;
  initialMonths: TrendWindow;
  onClose: () => void;
}) {
  const panelRef = useDialog(onClose);

  const [months, setMonths] = useState<TrendWindow>(initialMonths);
  const [bucket, setBucket] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [pageSize, setPageSize] = useState(25);
  const [offset, setOffset] = useState(0);

  const [drill, setDrill] = useState<DrillIn | null>(null);
  const [selected, setSelected] = useState<Complaint | null>(null);
  // Populated only when the grouped fill fails; see the catch below.
  const [fallback, setFallback] = useState<Complaint[] | null>(null);

  // Results are tagged with the request that produced them and compared against
  // the current one, rather than being cleared by a second effect. A stale page
  // therefore stops rendering the moment a filter changes, with no intermediate
  // state write — the same approach AddressSearch uses for its suggestions.
  const requestKey = [
    lat,
    lng,
    tier,
    radiusMeters,
    months,
    bucket,
    status,
    offset,
    pageSize,
  ].join("|");
  const [fetched, setFetched] = useState<{
    key: string;
    items?: ComplaintGroup[];
    total?: number;
    truncated?: boolean;
    error?: string;
  } | null>(null);

  const current = fetched?.key === requestKey ? fetched : null;
  const groups = current?.items ?? null;
  const error = current?.error ?? null;
  const total = current?.total ?? 0;
  const truncated = current?.truncated ?? false;

  // Filters own the page reset, because changing one invalidates the page
  // number. Doing it in an effect would render one frame against the wrong
  // offset first.
  const changeFilter =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setOffset(0);
    };

  useEffect(() => {
    let cancelled = false;

    fetchComplaintGroups(lat, lng, tier, radiusMeters, {
      months,
      bucket: bucket === "all" ? undefined : bucket,
      status: status === "all" ? undefined : (status as ComplaintStatus),
      offset,
      limit: pageSize,
    })
      .then((page) => {
        if (cancelled) return;
        setFetched({
          key: requestKey,
          items: page.items,
          total: page.total,
          truncated: page.truncated,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        // Replaces the fact rotation rather than leaving a fact frozen behind a
        // request that already failed.
        setFetched({
          key: requestKey,
          error: e instanceof Error ? e.message : "Couldn't load complaints.",
        });
        // Then fall back to the bounded, ungrouped path. The grouped fill is the
        // slow, failure-prone one; the plain listing is the same request the
        // report page already survives on, so a renter still sees recent
        // complaints instead of a dead end.
        fetchNearbyComplaints(lat, lng, radiusMeters, tier).then((items) => {
          if (!cancelled) setFallback(items);
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    requestKey,
    lat,
    lng,
    tier,
    radiusMeters,
    months,
    bucket,
    status,
    offset,
    pageSize,
  ]);

  // Drill-in page loads separately; the group already told us its size.
  useEffect(() => {
    if (!drill || drill.items !== null) return;
    let cancelled = false;

    fetchGroupDetail(lat, lng, tier, {
      day: drill.group.day,
      type: drill.group.type,
      status: status === "all" ? undefined : (status as ComplaintStatus),
      offset: drill.offset,
      limit: pageSize,
    })
      .then((page) => {
        if (cancelled) return;
        // Prefer the total this response states over the group row's cached
        // count. Socrata answers from replicas of differing freshness, so the
        // cached count and this list can genuinely describe different data —
        // and a header saying 4 above a list of 8 is the worst of both. Falls
        // back to the group's count when the page is not the last one, where
        // the exact total is not knowable from this response alone.
        setDrill((d) =>
          d ? { ...d, items: page.items, total: page.total ?? d.total } : d,
        );
      })
      .catch(() => {
        if (cancelled) return;
        setDrill((d) => (d ? { ...d, items: [] } : d));
      });

    return () => {
      cancelled = true;
    };
  }, [drill, lat, lng, tier, status, pageSize]);

  const bucketOptions = [
    { value: "all", label: "All" },
    ...TIER_BUCKETS[tier].map((b) => ({
      value: b,
      label: CATEGORY_LABEL[b] ?? b,
    })),
  ];
  const statusOptions = [
    { value: "all", label: "All" },
    ...COMPLAINT_STATUS_OPTIONS.map((o) => ({
      value: o.value as string,
      label: o.label,
    })),
  ];

  return (
    <Portal>
      <div
        className="fixed inset-0 z-60 flex items-center justify-center p-4"
        style={{ background: "color-mix(in srgb, black 50%, transparent)" }}
        onClick={onClose}
      >
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={`All ${panelLabel} complaints`}
          className="flex max-h-[85dvh] w-full max-w-2xl flex-col rounded-lg outline-none"
          style={{
            background: "var(--surface-1)",
            boxShadow: "var(--shadow-lg)",
            border: "1px solid var(--border-hairline)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="flex shrink-0 items-start justify-between gap-4 border-b p-5 sm:p-6"
            style={{ borderColor: "var(--border-hairline)" }}
          >
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-(--text-primary)">
                {drill ? drill.group.type : `${panelLabel} complaints`}
              </h2>
              <p className="text-xs text-(--text-muted)">
                {drill
                  ? `${formatDay(drill.group.day)} · ${drill.total.toLocaleString()} ${drill.total === 1 ? "complaint" : "complaints"}`
                  : `Within ${formatDistance(radiusMeters)}`}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 rounded-full p-1 text-(--text-secondary) transition-colors hover:bg-(--gridline) hover:text-(--text-primary)"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          {drill ? (
            <DrillInPane
              drill={drill}
              pageSize={pageSize}
              onBack={() => setDrill(null)}
              onOffsetChange={(next) =>
                setDrill({ ...drill, offset: next, items: null })
              }
              onSelect={setSelected}
            />
          ) : (
            <>
              <div
                className="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-3 sm:px-6"
                style={{ borderColor: "var(--border-hairline)" }}
                // Hidden on the fallback path: these filter the grouped data,
                // which is exactly what failed to load, so offering them would
                // promise something the fallback cannot do.
                hidden={Boolean(error)}
              >
                <FilterChips
                  label="Time window"
                  options={TREND_WINDOW_OPTIONS.map((m) => ({
                    value: m,
                    label: String(m),
                  }))}
                  value={months}
                  onChange={changeFilter((m: number) =>
                    setMonths(m as TrendWindow),
                  )}
                  suffix="mo"
                />
                <FilterChips
                  label="Complaint type"
                  options={bucketOptions}
                  value={bucket}
                  onChange={changeFilter(setBucket)}
                />
                <FilterChips
                  label="Status"
                  options={statusOptions}
                  value={status}
                  onChange={changeFilter(setStatus)}
                />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 sm:px-6">
                {error ? (
                  <FallbackList
                    error={error}
                    items={fallback}
                    onSelect={setSelected}
                  />
                ) : groups === null ? (
                  <FactRotator />
                ) : groups.length === 0 ? (
                  <p className="py-16 text-center text-sm text-(--text-muted)">
                    No complaints match these filters.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-(--gridline)">
                    {groups.map((g) => (
                      <li key={`${g.day}|${g.type}`}>
                        <button
                          type="button"
                          onClick={() =>
                            setDrill({
                              group: g,
                              items: null,
                              total: g.total,
                              offset: 0,
                            })
                          }
                          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md py-2.5 text-left text-sm transition-colors hover:bg-(--surface-2)"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-(--text-primary)">
                              {g.type}
                            </p>
                            <p className="font-data text-xs text-(--text-muted)">
                              {formatDay(g.day)}
                            </p>
                          </div>
                          <span className="flex shrink-0 items-center gap-2.5">
                            <StatusDots counts={g.counts} />
                            <span className="font-data text-xs font-medium text-(--text-primary)">
                              {g.total}
                            </span>
                            <ChevronRightIcon className="h-3.5 w-3.5 text-(--text-muted)" />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="shrink-0 px-5 pb-5 sm:px-6 sm:pb-6">
                {truncated && (
                  <p className="pb-2 text-[11px] text-(--text-muted)">
                    This address has more history than we can hold — showing the
                    most recent records only.
                  </p>
                )}
                {groups !== null && !error && (
                  <Pager
                    offset={offset}
                    pageSize={pageSize}
                    total={total}
                    label={{ one: "day", many: "days" }}
                    onOffsetChange={setOffset}
                    onPageSizeChange={changeFilter(setPageSize)}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {selected && (
          <ComplaintDetailModal
            complaint={selected}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </Portal>
  );
}

/**
 * One dot per status present, so a day's mix is readable without opening it.
 *
 * The per-status number is shown only when a day actually has a mix. On the
 * common single-status day it would just repeat the row's total back at you —
 * "1 1" — so the dot alone carries the colour and the total carries the count.
 */
function StatusDots({ counts }: { counts: Record<ComplaintStatus, number> }) {
  const present = (Object.keys(counts) as ComplaintStatus[]).filter(
    (s) => counts[s] > 0,
  );
  const mixed = present.length > 1;

  return (
    <span className="flex items-center gap-1.5">
      {present.map((s) => (
        <span
          key={s}
          className="inline-flex items-center gap-1 whitespace-nowrap text-[11px]"
          style={{ color: `var(${STATUS_VAR[s]}-ink)` }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: `var(${STATUS_VAR[s]})` }}
          />
          {mixed && counts[s]}
          <span className="sr-only">
            {counts[s]} {STATUS_LABEL[s]}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * What the browser shows when the grouped fill fails.
 *
 * Says plainly that this is the reduced view rather than presenting a capped
 * list as though it were the whole history.
 */
function FallbackList({
  error,
  items,
  onSelect,
}: {
  error: string;
  items: Complaint[] | null;
  onSelect: (complaint: Complaint) => void;
}) {
  return (
    <div className="py-4">
      <p
        className="mb-4 rounded-lg px-3 py-2.5 text-xs"
        style={{
          color: "var(--status-warning-ink)",
          background:
            "color-mix(in srgb, var(--status-warning) 14%, transparent)",
        }}
      >
        {error} Showing the most recent complaints instead. Filters and full
        history are unavailable.
      </p>

      {items === null ? (
        <div className="flex justify-center py-10">
          <div
            className="h-6 w-6 animate-spin rounded-full border-2 motion-reduce:animate-none"
            style={{
              borderColor: "var(--border-strong)",
              borderTopColor: "transparent",
            }}
            aria-label="Loading recent complaints"
          />
        </div>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-sm text-(--text-muted)">
          No complaints could be loaded for this address.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-(--gridline)">
          {items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c)}
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md py-2.5 text-left text-sm transition-colors hover:bg-(--surface-2)"
              >
                <div className="min-w-0">
                  <p className="truncate text-(--text-primary)">{c.label}</p>
                  <p className="font-data text-xs text-(--text-muted)">
                    {new Date(`${c.date}T00:00:00`).toLocaleDateString(
                      "en-US",
                      {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      },
                    )}
                  </p>
                </div>
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs"
                  style={{ color: `var(${STATUS_VAR[c.status]}-ink)` }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: `var(${STATUS_VAR[c.status]})` }}
                  />
                  {STATUS_LABEL[c.status]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The individual complaints for one day+type.
 *
 * A pane rather than a third stacked dialog: nesting two modals to reach one
 * complaint buries the way back out.
 */
function DrillInPane({
  drill,
  pageSize,
  onBack,
  onOffsetChange,
  onSelect,
}: {
  drill: DrillIn;
  pageSize: number;
  onBack: () => void;
  onOffsetChange: (offset: number) => void;
  onSelect: (complaint: Complaint) => void;
}) {
  return (
    <>
      <div
        className="shrink-0 border-b px-5 py-2.5 sm:px-6"
        style={{ borderColor: "var(--border-hairline)" }}
      >
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-h-8 items-center gap-1.5 text-xs font-semibold text-(--brand-ink)"
        >
          <ChevronRightIcon className="h-3 w-3 rotate-180" />
          All days
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 sm:px-6">
        {drill.items === null ? (
          <div className="flex justify-center py-16">
            <div
              className="h-6 w-6 animate-spin rounded-full border-2 motion-reduce:animate-none"
              style={{
                borderColor: "var(--border-strong)",
                borderTopColor: "transparent",
              }}
              aria-label="Loading complaints"
            />
          </div>
        ) : drill.items.length === 0 ? (
          <p className="py-16 text-center text-sm text-(--text-muted)">
            No complaints to show for this day.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-(--gridline)">
            {drill.items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c)}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md py-2.5 text-left text-sm transition-colors hover:bg-(--surface-2)"
                >
                  <p className="min-w-0 truncate text-(--text-primary)">
                    {c.label}
                  </p>
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
      </div>

      <div className="shrink-0 px-5 pb-5 sm:px-6 sm:pb-6">
        <Pager
          offset={drill.offset}
          pageSize={pageSize}
          total={drill.total}
          label={{ one: "complaint", many: "complaints" }}
          onOffsetChange={onOffsetChange}
        />
      </div>
    </>
  );
}
