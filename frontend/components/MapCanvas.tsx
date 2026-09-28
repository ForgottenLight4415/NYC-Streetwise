"use client";

import { useEffect, useRef, useState } from "react";
import { mapId } from "../lib/maps-keys";
import { getResolvedTheme, subscribeResolvedTheme } from "../lib/theme";

// The SDK arrives from a <script> tag rather than npm, so @types/google.maps
// supplies the `google.maps.*` namespace and this declares the global it
// attaches itself to. Optional because the script is skipped entirely when no
// client key is configured.
declare global {
  interface Window {
    google?: typeof google;
  }
}

export interface MapRing {
  radiusMeters: number;
  /** CSS custom property (sans `var()`), e.g. "--series-building". */
  colorVar: string;
  label: string;
}

export interface ResolvedRing {
  radiusMeters: number;
  colorVar: string;
  label: string;
}

/** One secondary pin - e.g. an amenity instance in the amenity browser. */
export interface MapExtraMarker {
  lat: number;
  lng: number;
  label: string;
}

/**
 * Collapses rings that share a radius into one circle and one legend row.
 *
 * All four amenity tiers (transit/parks/bike/walkability) use the same 800m
 * walkshed, so a naive per-category draw would paint four identical circles
 * on top of each other and list four identical legend rows. Grouped by
 * radius instead: the merged label says which categories share it, and the
 * circle draws once.
 */
export function dedupeRings(rings: MapRing[]): ResolvedRing[] {
  const byRadius = new Map<number, MapRing[]>();
  for (const ring of rings) {
    const group = byRadius.get(ring.radiusMeters) ?? [];
    group.push(ring);
    byRadius.set(ring.radiusMeters, group);
  }
  return [...byRadius.values()]
    .map((group) => ({
      radiusMeters: group[0].radiusMeters,
      colorVar: group[0].colorVar,
      label: group.map((r) => r.label).join(" · "),
    }))
    .sort((a, b) => a.radiusMeters - b.radiusMeters);
}

/**
 * Resolves once the Maps SDK has attached itself to `window`.
 *
 * The script is loaded with `async`, so there is no ordering guarantee against
 * React hydration - this effect can run first. The previous code treated that
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

/** Module-scope, so an omitted `extraMarkers` prop doesn't get a fresh []
 *  identity every render - same convention AddressSearch.tsx uses for its
 *  own EMPTY/NO_SUGGESTIONS constants. */
const EMPTY_MARKERS: MapExtraMarker[] = [];

/** Zoom ceiling for `fitToMarkers`. A single instance a few doors away would
 *  otherwise fit to a bounds box a handful of metres across and land at
 *  max zoom, showing a rooftop with no surrounding context. */
const FIT_MAX_ZOOM = 17;

/**
 * The map itself - a Google vector map in a sized <div>, with the searched
 * address pin, optional radius rings, and optional secondary pins.
 *
 * Deliberately chrome-less: no coordinate header, no legend, no card border.
 * `MapPanel` wraps this in the report page's panel chrome; the amenity
 * browser modal mounts it bare at its own height. Everything that both
 * placements need to get right and expensive to duplicate - waiting for the
 * async SDK script, rebuilding on theme change without tearing a live WebGL
 * context out from under itself, resolving CSS custom properties into the
 * literal colors the SDK demands, the Street View resize kick - lives here
 * once.
 */
export function MapCanvas({
  centerLat,
  centerLng,
  rings,
  extraMarkers = EMPTY_MARKERS,
  extraMarkersColorVar,
  fitToMarkers = false,
  className,
  onLoadingChange,
}: {
  centerLat: number;
  centerLng: number;
  rings: MapRing[];
  /** Secondary pins - e.g. every instance of one amenity bucket in the
   *  amenity browser. Empty/omitted draws none. */
  extraMarkers?: MapExtraMarker[];
  /** CSS custom property (sans `var()`) tinting every extra marker - the
   *  open bucket's own tier color, so the pins read as "these belong to the
   *  card/modal you just opened" rather than an unrelated overlay. Falls
   *  back to a neutral token when omitted. */
  extraMarkersColorVar?: string;
  /** Frame the extra pins instead of holding the default zoom-16 view of the
   *  center. Used by the amenity browser, where the point of the map is
   *  "where are these N things relative to the address", and a fixed zoom
   *  would push the outer ones off-canvas at an 800m walkshed. Ignored when
   *  there are no extra pins. */
  fitToMarkers?: boolean;
  /** Height/size utilities for the map container - the canvas has no
   *  intrinsic size, so a caller that omits this gets a 0px-tall map. */
  className?: string;
  /** Lets the wrapper show its own "Loading map…" text. Pass a stable
   *  function (a `useState` setter is ideal). */
  onLoadingChange?: (isLoading: boolean) => void;
}) {
  const resolvedRings = dedupeRings(rings);
  // A serialised key, not the array itself: `rings` gets a fresh identity on
  // every render, and depending on it directly would rebuild the WebGL
  // context and the whole tile chain every time. This only changes when a
  // radius or color actually does.
  const ringsKey = resolvedRings
    .map((r) => `${r.radiusMeters}:${r.colorVar}`)
    .join(",");

  // Same trick, same reason, for the secondary pins: `extraMarkers` is a
  // fresh array every render (it's derived from an SWR result one level up),
  // so the effect below depends on this serialised key instead - it only
  // actually changes when the open bucket, or the instances it resolved to,
  // changes, which is exactly when the pins need to be redrawn.
  const extraMarkersKey = extraMarkers
    .map((m) => `${m.lat.toFixed(6)},${m.lng.toFixed(6)}`)
    .join("|");

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mapInitError, setMapInitError] = useState<string | null>(null);
  useEffect(() => {
    onLoadingChange?.(isLoading);
  }, [isLoading, onLoadingChange]);
  // A light Google basemap inside a dark page was the single most jarring thing
  // in the dark theme. `colorScheme` is fixed at construction, so the theme has
  // to be an input to this component and rebuild the map when it changes.
  //
  // The OBSERVER is now shared (lib/theme.ts) instead of private to this
  // component, which is the point of the change: the compare view mounts two of
  // these, and that was two MutationObservers watching one attribute.
  //
  // The initial value is still seeded synchronously from the DOM, deliberately.
  // useSyncExternalStore would be the tidier way to read a shared store, but its
  // server snapshot cannot know the theme and has to answer "light" - so the
  // first client render says light and the second says dark, the effect below
  // re-runs on that change, and a SECOND map gets built into the same container,
  // pulling the WebGL context out from under the first. That is the exact bug
  // the original lazy initializer was written to avoid, and it stays avoided.
  const [theme, setTheme] = useState<string>(() =>
    typeof document === "undefined" ? "light" : getResolvedTheme(),
  );
  useEffect(
    () => subscribeResolvedTheme(() => setTheme(getResolvedTheme())),
    [],
  );

  useEffect(() => {
    if (!mapContainerRef.current) return;
    let cancelled = false;

    async function initMap() {
      try {
        const maps = await whenMapsReady();
        if (cancelled) return;
        if (!maps) {
          // The map script is injected by app/layout.tsx from the CLIENT key.
          // A missing map is a client-key problem, not a server-key one - the
          // search box above can be working fine off GOOGLE_MAPS_API_KEY while
          // this panel is blank.
          throw new Error(
            "Google Maps API not loaded. Set GOOGLE_MAPS_CLIENT_KEY in frontend/.env.local.",
          );
        }

        const { Map } = (await maps.maps.importLibrary(
          "maps",
        )) as google.maps.MapsLibrary;
        const { AdvancedMarkerElement, PinElement } =
          (await maps.maps.importLibrary(
            "marker",
          )) as google.maps.MarkerLibrary;

        if (cancelled || !mapContainerRef.current) return;

        const map = new Map(mapContainerRef.current, {
          center: { lat: centerLat, lng: centerLng },
          zoom: 16,
          mapId: mapId(),
          disableDefaultUI: false,
          colorScheme:
            theme === "dark"
              ? maps.maps.ColorScheme.DARK
              : maps.maps.ColorScheme.LIGHT,
        });
        mapRef.current = map;

        // Dragging the yellow Pegman onto the map opens Street View linked
        // to this map. Some panoramas (particularly third-party 360 photos
        // like "Threshold 360" real-estate listings) render as a blank
        // black canvas until the WebGL viewport is forced to recompute
        // after the panel becomes visible - retriggering a resize (twice,
        // since the container can still be mid-layout on the first pass)
        // reliably kicks the texture into painting.
        const panorama = map.getStreetView();
        const kickPanoramaResize = () =>
          maps.maps.event.trigger(panorama, "resize");
        maps.maps.event.addListener(panorama, "visible_changed", () => {
          if (!panorama.getVisible()) return;
          kickPanoramaResize();
          setTimeout(kickPanoramaResize, 300);
        });
        maps.maps.event.addListener(panorama, "pano_changed", () => {
          if (panorama.getVisible()) setTimeout(kickPanoramaResize, 300);
        });

        // The Maps SDK takes literal colors, not CSS variables, so these are
        // resolved from the live computed styles instead of being hardcoded -
        // that way the pin and radius rings re-color with the theme and stay
        // in step with the legend below the map.
        // One computed-style read, not one per token. getComputedStyle resolves
        // the element's full style; calling it five times asked for that work
        // five times to pull five custom properties out of the same result.
        const rootStyle = getComputedStyle(document.documentElement);
        const token = (name: string, fallback: string) =>
          rootStyle.getPropertyValue(name).trim() || fallback;

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

        // Secondary pins - every real instance of one amenity bucket in the
        // amenity browser. Deliberately smaller and tinted with the bucket's
        // own tier color (not --status-critical) so they read as "the thing
        // you're browsing," never mistaken for the searched address itself.
        // A fresh PinElement per marker: content is a DOM node, so one
        // instance cannot be shared across markers the way the color token
        // above is.
        extraMarkers.forEach((marker) => {
          const extraPin = new PinElement({
            background: token(
              extraMarkersColorVar ?? "--text-muted",
              "#8a929e",
            ),
            borderColor: token(
              extraMarkersColorVar
                ? `${extraMarkersColorVar}-ink`
                : "--text-secondary",
              "#626b77",
            ),
            glyphColor: token("--surface-1", "#ffffff"),
            scale: 0.75,
          });

          new AdvancedMarkerElement({
            map,
            position: { lat: marker.lat, lng: marker.lng },
            content: extraPin,
            title: marker.label,
          });
        });

        resolvedRings.forEach((ring, i) => {
          new maps.maps.Circle({
            map,
            center: { lat: centerLat, lng: centerLng },
            radius: ring.radiusMeters,
            strokeColor: token(ring.colorVar, "#888888"),
            // Innermost ring drawn most opaque, same falloff the original
            // building(0.7)/block(0.55) pair used, generalised to N rings.
            strokeOpacity: Math.max(0.35, 0.7 - i * 0.15),
            strokeWeight: 2,
            fillOpacity: 0,
          });
        });

        // Framing pass, after the pins exist. `fitBounds` alone can land at
        // street-level zoom when the bounds box is tiny (one nearby
        // instance), so the zoom is clamped once the camera settles.
        if (fitToMarkers && extraMarkers.length > 0) {
          const bounds = new maps.maps.LatLngBounds();
          bounds.extend({ lat: centerLat, lng: centerLng });
          for (const marker of extraMarkers) {
            bounds.extend({ lat: marker.lat, lng: marker.lng });
          }
          // 24px of padding, not the SDK's default 45-ish: this map can be
          // as short as ~190px (the amenity browser's), where padding on
          // both edges eats the viewport and zooms the whole walkshed out
          // to a neighbourhood view.
          map.fitBounds(bounds, 24);
          maps.maps.event.addListenerOnce(map, "idle", () => {
            const zoom = map.getZoom();
            if (zoom != null && zoom > FIT_MAX_ZOOM) map.setZoom(FIT_MAX_ZOOM);
          });
        }

        setIsLoading(false);
      } catch (error) {
        console.error("Error initializing map:", error);
        if (!cancelled) {
          setMapInitError(
            error instanceof Error
              ? error.message
              : "Failed to load Google Maps",
          );
          setIsLoading(false);
        }
      }
    }

    initMap();
    return () => {
      cancelled = true;
    };
    // resolvedRings/extraMarkers deliberately omitted: both are fresh arrays
    // every render, and their *Key strings already capture everything about
    // them the effect draws (radius/color for rings; lat/lng for markers) -
    // see the comments on ringsKey and extraMarkersKey above. extraMarkersColorVar
    // and fitToMarkers ARE dependencies in their own right (primitives the
    // effect reads directly), so they're listed rather than folded into a key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    centerLat,
    centerLng,
    ringsKey,
    extraMarkersKey,
    extraMarkersColorVar,
    fitToMarkers,
    theme,
  ]);

  return (
    <div ref={mapContainerRef} className={className}>
      {mapInitError && (
        <div className="flex h-full items-center justify-center p-4 text-center">
          <div>
            <p
              className="text-sm font-medium"
              style={{ color: "var(--status-critical)" }}
            >
              {mapInitError}
            </p>
            <p className="mt-2 text-xs text-(--text-muted)">
              Add a{" "}
              <code className="rounded bg-(--surface-2) px-1.5 py-0.5">
                frontend/.env.local
              </code>{" "}
              with a Maps JavaScript API key:
              <br />
              <code className="mt-2 inline-block rounded bg-(--surface-2) px-1.5 py-0.5">
                GOOGLE_MAPS_CLIENT_KEY=your_browser_key
              </code>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
