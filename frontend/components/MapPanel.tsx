"use client";

import { useEffect, useRef, useState } from "react";
import { MapPinIcon } from "./icons";
import { mapId } from "../lib/maps-keys";

declare global {
  interface Window {
    google?: any;
  }
}

export function MapPanel({
  centerLat,
  centerLng,
  buildingRadiusMeters,
  blockRadiusMeters,
}: {
  centerLat: number;
  centerLng: number;
  buildingRadiusMeters: number;
  blockRadiusMeters: number;
}) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mapInitError, setMapInitError] = useState<string | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current) return;
    let cancelled = false;

    async function initMap() {
      try {
        if (!window.google) {
          // The map script is injected by app/layout.tsx from the CLIENT key.
          // A missing map is a client-key problem, not a server-key one — the
          // search box above can be working fine off GOOGLE_MAPS_API_KEY while
          // this panel is blank.
          throw new Error(
            "Google Maps API not loaded. Set GOOGLE_MAPS_CLIENT_KEY in frontend/.env.local."
          );
        }

        const { Map } = await window.google.maps.importLibrary("maps");
        const { AdvancedMarkerElement, PinElement } = await window.google.maps.importLibrary("marker");

        if (cancelled || !mapContainerRef.current) return;

        const map = new Map(mapContainerRef.current, {
          center: { lat: centerLat, lng: centerLng },
          zoom: 16,
          mapId: mapId(),
          disableDefaultUI: false,
        });
        mapRef.current = map;

        // Dragging the yellow Pegman onto the map opens Street View linked
        // to this map. Some panoramas (particularly third-party 360 photos
        // like "Threshold 360" real-estate listings) render as a blank
        // black canvas until the WebGL viewport is forced to recompute
        // after the panel becomes visible — retriggering a resize (twice,
        // since the container can still be mid-layout on the first pass)
        // reliably kicks the texture into painting.
        const panorama = map.getStreetView();
        const kickPanoramaResize = () => window.google.maps.event.trigger(panorama, "resize");
        window.google.maps.event.addListener(panorama, "visible_changed", () => {
          if (!panorama.getVisible()) return;
          kickPanoramaResize();
          setTimeout(kickPanoramaResize, 300);
        });
        window.google.maps.event.addListener(panorama, "pano_changed", () => {
          if (panorama.getVisible()) setTimeout(kickPanoramaResize, 300);
        });

        const pin = new PinElement({
          background: "#FF4136",
          borderColor: "#B0221A",
          glyphColor: "#FFFFFF",
          scale: 1.1,
        });

        new AdvancedMarkerElement({
          map,
          position: { lat: centerLat, lng: centerLng },
          content: pin,
          title: "Searched address",
        });

        new window.google.maps.Circle({
          map,
          center: { lat: centerLat, lng: centerLng },
          radius: buildingRadiusMeters,
          strokeColor: "#3B82F6",
          strokeOpacity: 0.7,
          strokeWeight: 2,
          fillOpacity: 0,
        });

        new window.google.maps.Circle({
          map,
          center: { lat: centerLat, lng: centerLng },
          radius: blockRadiusMeters,
          strokeColor: "#8B5CF6",
          strokeOpacity: 0.4,
          strokeWeight: 2,
          fillOpacity: 0,
        });

        setIsLoading(false);
      } catch (error) {
        console.error("Error initializing map:", error);
        if (!cancelled) {
          setMapInitError(error instanceof Error ? error.message : "Failed to load Google Maps");
          setIsLoading(false);
        }
      }
    }

    initMap();
    return () => {
      cancelled = true;
    };
  }, [centerLat, centerLng, buildingRadiusMeters, blockRadiusMeters]);

  return (
    <div
      className="overflow-hidden rounded-[var(--radius-lg)]"
      style={{ boxShadow: "var(--shadow-md)", border: "1px solid var(--border-hairline)", background: "var(--surface-1)" }}
    >
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--border-hairline)" }}>
        <div className="flex items-center gap-2 text-xs text-[color:var(--text-muted)]">
          <MapPinIcon className="h-3.5 w-3.5" />
          {centerLat.toFixed(4)}, {centerLng.toFixed(4)} · {isLoading ? "Loading map…" : "Google Maps"}
        </div>
      </div>

      <div ref={mapContainerRef} className="w-full" style={{ height: "380px" }}>
        {mapInitError && (
          <div className="flex h-full items-center justify-center p-4 text-center">
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--status-critical)" }}>
                {mapInitError}
              </p>
              <p className="mt-2 text-xs text-[color:var(--text-muted)]">
                Add a <code className="rounded bg-[color:var(--surface-2)] px-1.5 py-0.5">frontend/.env.local</code>{" "}
                with a Maps JavaScript API key:
                <br />
                <code className="mt-2 inline-block rounded bg-[color:var(--surface-2)] px-1.5 py-0.5">
                  GOOGLE_MAPS_CLIENT_KEY=your_browser_key
                </code>
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 border-t px-4 py-2.5 text-xs text-[color:var(--text-secondary)]" style={{ borderColor: "var(--border-hairline)" }}>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--series-building)" }} />
          Building radius ({buildingRadiusMeters}m)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--series-block)" }} />
          Block radius ({blockRadiusMeters}m)
        </span>
      </div>
    </div>
  );
}
