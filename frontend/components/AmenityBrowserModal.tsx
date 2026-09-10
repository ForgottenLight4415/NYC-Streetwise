"use client";

import {
  formatDistance,
  formatDistanceRange,
  formatWalk,
  formatWalkRange,
} from "@/lib/amenities";
import { useNearbyAmenities } from "@/lib/hooks";
import { useDialog } from "@/lib/useDialog";
import type { CategoryId } from "@/lib/types";
import { CloseIcon } from "./icons";
import { Portal } from "./Portal";
import { TransitLineBadge } from "./TransitLineBadge";

/**
 * Every real instance of one amenity bucket within its tier's radius -
 * behind a "Nearest by type" row's `>` affordance, not just the single
 * nearest one that row itself shows.
 *
 * Mirrors ComplaintsBrowserModal's outer chrome (fixed inset-0 overlay,
 * header with a close button, scrollable list body, loading/empty/error
 * states) but the content underneath is far simpler: no filters, no paging,
 * no drill-in pane - a flat, nearest-first list, since
 * GET /api/amenities/nearby is a single fast in-memory lookup rather than a
 * paginated Socrata fill.
 *
 * For `subway`/`bus`, each returned instance already represents a whole
 * station complex or physical bus pole, not a raw entrance/GTFS record -
 * the backend groups, same-line-dedups, and caps those two buckets before
 * this ever sees them (amenityService.js's getNearbyAmenityInstances). So
 * this component stays a plain one-row-per-instance list, the same style
 * AmenityMetricRows already uses for the single-nearest summary row - no
 * client-side grouping needed here. `subway` instances additionally carry
 * `entrances` (every member entrance's own distance) when there's more than
 * one - surfaced as a small "N entrances · 0.1 mi–0.4 mi" tag next to the
 * name, collapsing every door's own distance into one range rather than
 * listing all of them (a 35-entrance hub would otherwise print 35 near-
 * duplicate "0.2 mi" lines). The row's own walk-time display on the right
 * spans the same entrances too (`formatWalkRange`, "1–3 min walk") rather
 * than timing only the single nearest door - the tag's distance range and
 * the row's walk-time range describe the same spread in each unit, instead
 * of one collapsing to nearest-only.
 */
export function AmenityBrowserModal({
  lat,
  lng,
  tier,
  bucket,
  bucketLabel,
  onClose,
}: {
  lat: number;
  lng: number;
  tier: CategoryId;
  bucket: string;
  bucketLabel: string;
  onClose: () => void;
}) {
  const panelRef = useDialog(onClose);
  const { data, error, isLoading } = useNearbyAmenities(
    { lat, lng },
    tier,
    bucket,
  );

  // TransitLineBadge only knows these two modes - every other bucket has no
  // route concept, and AmenityInstance.routes is absent for them anyway.
  const mode = bucket === "subway" || bucket === "bus" ? bucket : null;

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
          aria-label={`Every ${bucketLabel} nearby`}
          className="flex max-h-[85dvh] w-full max-w-md flex-col rounded-lg outline-none"
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
                {bucketLabel}
              </h2>
              <p className="text-xs text-(--text-muted)">
                {data ? `Within ${formatDistance(data.radiusMeters)}` : " "}
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

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-1 sm:px-6">
            {error ? (
              <p
                className="py-16 text-center text-sm"
                style={{ color: "var(--status-critical-ink)" }}
              >
                Couldn&apos;t load nearby {bucketLabel.toLowerCase()}.
              </p>
            ) : isLoading || !data ? (
              <div className="flex justify-center py-16">
                <div
                  className="h-6 w-6 animate-spin rounded-full border-2 motion-reduce:animate-none"
                  style={{
                    borderColor: "var(--border-strong)",
                    borderTopColor: "transparent",
                  }}
                  aria-label={`Loading nearby ${bucketLabel.toLowerCase()}`}
                />
              </div>
            ) : data.instances.length === 0 ? (
              <p className="py-16 text-center text-sm text-(--text-muted)">
                Nothing within {formatDistance(data.radiusMeters)}.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-(--gridline)">
                {data.instances.map((inst, i) => (
                  <li
                    key={`${inst.lat},${inst.lng},${i}`}
                    className="flex items-center justify-between gap-3 py-2.5 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <p className="min-w-0 truncate text-(--text-primary)">
                          {inst.name ?? bucketLabel}
                        </p>
                        {inst.entrances && inst.entrances.length > 1 && (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold w-fit"
                            style={{
                              background: "var(--brand-tint)",
                              color: "var(--brand-ink)",
                            }}
                          >
                            <span
                              className="h-1 w-1 rounded-full"
                              style={{ background: "var(--brand)" }}
                            />
                            {inst.entrances.length} entrances ·{" "}
                            {formatDistanceRange(inst.entrances)}
                          </span>
                        )}
                      </div>
                      {mode && inst.routes && inst.routes.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {inst.routes.map((route) => (
                            <TransitLineBadge
                              key={route}
                              route={route}
                              mode={mode}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                    <span className="font-data shrink-0 text-xs text-(--text-muted)">
                      {inst.entrances && inst.entrances.length > 1
                        ? formatWalkRange(inst.entrances)
                        : formatWalk(inst.meters)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
