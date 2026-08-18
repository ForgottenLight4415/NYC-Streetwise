"use client";

import { useEffect, useRef, useState } from "react";
import { MapPinIcon } from "./icons";
import { mapId } from "../lib/maps-keys";

// The SDK arrives from a <script> tag rather than npm, so @types/google.maps
// supplies the `google.maps.*` namespace and this declares the global it
// attaches itself to. Optional because the script is skipped entirely when no
// client key is configured.
declare global {
  interface Window {
    google?: typeof google;
  }
}

/**
 * Resolves once the Maps SDK has attached itself to `window`.
 *
 * The script is loaded with `async`, so there is no ordering guarantee against
 * React hydration — this effect can run first. The previous code treated that
 * race as a missing API key and rendered a setup error, which was wrong and
 * intermittent. Waiting is also what makes `loading=async` safe to request.
 */
function whenMapsReady(timeoutMs = 10000): Promise<typeof google | null> {
  if (window.google?.maps) return Promise.resolve(window.google);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = window.setInterval(() => {
      if (window.google?.maps) {
        window.clearInterval(poll);
        resolve(window.google);
      } else if (Date.now() - startedAt > timeoutMs) {
        window.clearInterval(poll);
        resolve(null);
      }
    }, 60);
  });
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
  const mapRef = useRef<google.maps.Map | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mapInitError, setMapInitError] = useState<string | null>(null);
  // A light Google basemap inside a dark page was the single most jarring thing
  // in the dark theme. `colorScheme` is fixed at construction, so the theme has
  // to be part of this component's state and rebuild the map when it changes.
  //
  // Seeded from the DOM in the initializer rather than from an effect: starting
  // at "light" and correcting on mount ran the map effect twice, which built a
  // second map into the same container and pulled the WebGL context out from
  // under the first.
  const [theme, setTheme] = useState<string>(() =>
    typeof document === "undefined"
      ? "light"
      : (document.documentElement.getAttribute("data-theme") ?? "light")
  );

  useEffect(() => {
    const read = () => setTheme(document.documentElement.getAttribute("data-theme") ?? "light");
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current) return;
    let cancelled = false;

    async function initMap() {
      try {
        const maps = await whenMapsReady();
        if (cancelled) return;
        if (!maps) {
          // The map script is injected by app/layout.tsx from the CLIENT key.
          // A missing map is a client-key problem, not a server-key one — the
          // search box above can be working fine off GOOGLE_MAPS_API_KEY while
          // this panel is blank.
          throw new Error(
            "Google Maps API not loaded. Set GOOGLE_MAPS_CLIENT_KEY in frontend/.env.local."
          );
        }

        const { Map } = (await maps.maps.importLibrary(
          "maps"
        )) as google.maps.MapsLibrary;
        const { AdvancedMarkerElement, PinElement } = (await maps.maps.importLibrary(
          "marker"
        )) as google.maps.MarkerLibrary;

        if (cancelled || !mapContainerRef.current) return;

        const map = new Map(mapContainerRef.current, {
          center: { lat: centerLat, lng: centerLng },
          zoom: 16,
          mapId: mapId(),
          disableDefaultUI: false,
          colorScheme:
            theme === "dark" ? maps.maps.ColorScheme.DARK : maps.maps.ColorScheme.LIGHT,
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
        const kickPanoramaResize = () => maps.maps.event.trigger(panorama, "resize");
        maps.maps.event.addListener(panorama, "visible_changed", () => {
          if (!panorama.getVisible()) return;
          kickPanoramaResize();
          setTimeout(kickPanoramaResize, 300);
        });
        maps.maps.event.addListener(panorama, "pano_changed", () => {
          if (panorama.getVisible()) setTimeout(kickPanoramaResize, 300);
        });

        // The Maps SDK takes literal colors, not CSS variables, so these are
        // resolved from the live computed styles instead of being hardcoded —
        // that way the pin and radius rings re-color with the theme and stay
        // in step with the legend below the map.
        const token = (name: string, fallback: string) =>
          getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

        const pin = new PinElement({
          background: token("--status-critical", "#dc3f3f"),
          borderColor: token("--status-critical-ink", "#b32020"),
          glyphColor: token("--surface-1", "#ffffff"),
          scale: 1.1,
        });

        new AdvancedMarkerElement({
          map,
          position: { lat: centerLat, lng: centerLng },
          content: pin,
          title: "Searched address",
        });

        new maps.maps.Circle({
          map,
          center: { lat: centerLat, lng: centerLng },
          radius: buildingRadiusMeters,
          strokeColor: token("--series-building", "#2f6fe0"),
          strokeOpacity: 0.7,
          strokeWeight: 2,
          fillOpacity: 0,
        });

        new maps.maps.Circle({
          map,
          center: { lat: centerLat, lng: centerLng },
          radius: blockRadiusMeters,
          strokeColor: token("--series-block", "#7a5af5"),
          strokeOpacity: 0.55,
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
  }, [centerLat, centerLng, buildingRadiusMeters, blockRadiusMeters, theme]);

  return (
    <div
      className="overflow-hidden rounded-[var(--radius-lg)]"
      style={{ boxShadow: "var(--shadow-md)", border: "1px solid var(--border-hairline)", background: "var(--surface-1)" }}
    >
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--border-hairline)" }}>
        <div className="flex min-w-0 items-center gap-2 text-xs text-[color:var(--text-muted)]">
          <MapPinIcon className="h-3.5 w-3.5" />
          <span className="font-data truncate">
            {centerLat.toFixed(4)}, {centerLng.toFixed(4)}
          </span>
          <span className="shrink-0">· {isLoading ? "Loading map…" : "Google Maps"}</span>
        </div>
      </div>

      {/* Shorter on a phone so the map does not eat the whole screen and hide
          the legend that explains the two rings. */}
      <div ref={mapContainerRef} className="h-[280px] w-full sm:h-[380px]">
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

      {/* flex-wrap: the two legend entries together run past 320px. */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t px-4 py-2.5 text-xs text-[color:var(--text-secondary)]"
        style={{ borderColor: "var(--border-hairline)" }}
      >
        {/* The label is one flex item, not three: as loose text plus a nested
            span, the parent's gap-1.5 was applied inside the parentheses and
            rendered as "( 25m )". */}
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--series-building)" }} />
          <span>
            Building radius (<span className="font-data">{buildingRadiusMeters}m</span>)
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--series-block)" }} />
          <span>
            Block radius (<span className="font-data">{blockRadiusMeters}m</span>)
          </span>
        </span>
      </div>
    </div>
  );
}
