"use client";

import { useState } from "react";
import { MapPinIcon } from "./icons";
import { formatDistance } from "../lib/amenities";
import { MapCanvas, dedupeRings, type MapRing } from "./MapCanvas";

export type { MapRing } from "./MapCanvas";

/**
 * The report page's (and each compare column's) map card: a coordinate
 * header, the map itself, and a legend naming every radius ring under it.
 *
 * The map machinery lives in `MapCanvas` - this is the chrome around it, and
 * the only consumer of `dedupeRings`' merged labels, which exist for the
 * legend rather than for the drawing.
 *
 * Note what is NOT here any more: secondary amenity pins. This card used to
 * take `extraMarkers` and repaint itself with every instance of whichever
 * amenity bucket the reader had opened - but that browser is a modal, so the
 * repaint happened on a map sitting behind the overlay, out of sight. Those
 * pins now render on `AmenityBrowserModal`'s own `MapCanvas`, next to the
 * list they belong to, and this card holds its address-plus-rings view
 * steady the whole time.
 */
export function MapPanel({
  centerLat,
  centerLng,
  rings,
}: {
  centerLat: number;
  centerLng: number;
  rings: MapRing[];
}) {
  const resolvedRings = dedupeRings(rings);
  const [isLoading, setIsLoading] = useState(true);

  return (
    <div
      className="overflow-hidden rounded-lg"
      style={{
        boxShadow: "var(--shadow-md)",
        border: "1px solid var(--border-hairline)",
        background: "var(--surface-1)",
      }}
    >
      <div
        className="flex items-center justify-between gap-2 border-b px-4 py-2.5"
        style={{ borderColor: "var(--border-hairline)" }}
      >
        <div className="flex min-w-0 items-center gap-2 text-xs text-(--text-muted)">
          <MapPinIcon className="h-3.5 w-3.5" />
          <span className="font-data truncate">
            {centerLat.toFixed(4)}, {centerLng.toFixed(4)}
          </span>
          <span className="shrink-0">
            · {isLoading ? "Loading map…" : "Google Maps"}
          </span>
        </div>
      </div>

      {/* Shorter on a phone so the map does not eat the whole screen and hide
          the legend that explains the two rings. */}
      <MapCanvas
        centerLat={centerLat}
        centerLng={centerLng}
        rings={rings}
        className="h-70 w-full sm:h-95"
        onLoadingChange={setIsLoading}
      />

      {/* flex-wrap: legend entries run past 320px once there are more than two. */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t px-4 py-2.5 text-xs text-(--text-secondary)"
        style={{ borderColor: "var(--border-hairline)" }}
      >
        {/* The label is one flex item, not three: as loose text plus a nested
            span, the parent's gap-1.5 was applied inside the parentheses and
            rendered as "( 25m )". */}
        {resolvedRings.map((ring) => (
          <span key={ring.label} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: `var(${ring.colorVar})` }}
            />
            <span>
              {ring.label} (
              <span className="font-data">
                {formatDistance(ring.radiusMeters)}
              </span>
              )
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
