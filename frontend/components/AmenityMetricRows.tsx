import { AMENITY_BUCKET_LABEL, formatWalk } from "@/lib/amenities";
import type { AmenityMetric } from "@/lib/types";
import { ChevronRightIcon } from "./icons";
import { TransitLineBadge } from "./TransitLineBadge";

/**
 * Buckets whose points are a resampled bike-route LINE, not discrete
 * real-world instances — see NON_DISCRETE_AMENITY_BUCKETS in the backend's
 * constants.js. GET /api/amenities/nearby refuses these outright, so the
 * `>` affordance is never offered for them in the first place.
 */
const NON_DISCRETE_BUCKETS = new Set(["bikeLane", "protectedLane"]);

/**
 * One row per bucket in an amenity tier that actually found something: the
 * label and the nearest one's NAME on the left, walk time and count on the
 * right.
 *
 * The name is what makes a row checkable — "0.3 mi to transit" is a claim,
 * "14 St–Union Sq" is a verifiable fact — so it is shown whenever the
 * dataset had one, even for a bucket that isn't the tier's overall nearest.
 *
 * A bucket with nothing within radiusMeters is dropped rather than shown as
 * a "None within Xm" row — a row with nothing to check isn't information,
 * and the panel's own summary already covers the "nothing nearby at all"
 * case for the tier as a whole.
 */
export function AmenityMetricRows({
  metrics,
  radiusMeters,
  onOpenBucket,
  onHoverBucket,
}: {
  metrics: Record<string, AmenityMetric>;
  radiusMeters: number;
  /**
   * Called with the bucket name when its `>` affordance is clicked. Omitted
   * entirely (no callback passed) means no chevron renders at all — used by
   * any caller that just wants a plain read of the metrics, same optional-
   * prop convention the rest of this codebase uses for opt-in affordances.
   */
  onOpenBucket?: (bucket: string) => void;
  /** Fired on hover/focus of any chevron — pulls the modal's JS chunk on
   *  intent, same preload-on-hover pattern ActivitySpine's "Browse" buttons
   *  use for ComplaintsBrowserModal. Bucket-agnostic: it just warms the one
   *  shared chunk, so every row can pass the same function reference. */
  onHoverBucket?: () => void;
}) {
  const entries = Object.entries(metrics).filter(
    ([, metric]) => metric.meters != null,
  );

  return (
    <div className="flex flex-col gap-2.5">
      {entries.map(([bucket, metric]) => {
        const walk = formatWalk(metric.meters);
        const canBrowse = Boolean(onOpenBucket) && !NON_DISCRETE_BUCKETS.has(bucket);
        return (
          <div
            key={bucket}
            className="flex items-center justify-between gap-3 py-1 text-sm"
          >
            <div className="min-w-0">
              <p className="text-(--text-secondary)">
                {AMENITY_BUCKET_LABEL[bucket] ?? bucket}
              </p>
              {metric.name && (
                <p className="truncate text-xs text-(--text-muted)">
                  {metric.name}
                </p>
              )}
              {/* `routes` only exists on subway/bus metrics — every other
                  bucket (parks, bike, walkability, rail) has no such field
                  at all, not even an empty array, so the bucket check must
                  run BEFORE touching `.routes` at all. */}
              {(bucket === "subway" || bucket === "bus") &&
                metric.routes &&
                metric.routes.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {metric.routes.map((route) => (
                      <TransitLineBadge key={route} route={route} mode={bucket} />
                    ))}
                  </div>
                )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <div className="text-right">
                <p className="font-data text-(--text-primary)">{walk}</p>
                {metric.within > 0 && (
                  <p className="font-data text-xs text-(--text-muted)">
                    {metric.within} within {radiusMeters}m
                  </p>
                )}
              </div>
              {canBrowse && (
                <button
                  type="button"
                  onClick={() => onOpenBucket!(bucket)}
                  onPointerEnter={onHoverBucket}
                  onFocus={onHoverBucket}
                  aria-label={`See every ${AMENITY_BUCKET_LABEL[bucket] ?? bucket} within ${radiusMeters}m`}
                  className="shrink-0 rounded-full p-1.5 text-(--text-muted) transition-colors hover:bg-(--surface-2) hover:text-(--text-primary)"
                >
                  <ChevronRightIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
