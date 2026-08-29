"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const MapPanel = dynamic(() => import("./MapPanel").then((m) => m.MapPanel), {
  ssr: false,
});

/**
 * `MapPanel`, but not until it is nearly on screen.
 *
 * Two costs are being deferred, and the second is the larger one:
 *
 *  1. The component's own JavaScript, via `dynamic`.
 *  2. Building the map — a WebGL context, a vector tile fetch chain, and the
 *     marker/maps SDK libraries `importLibrary` pulls at construction. The
 *     compare view mounts TWO of these, side by side, both below the fold.
 *
 * `rootMargin` is generous on purpose. The point is not to make the reader wait
 * at the moment they arrive; it is to skip the work entirely on the (common)
 * report view where nobody scrolls past the score panels. Starting 300px early
 * means it is already there when they do scroll.
 */
export function MapPanelLazy(props: {
  centerLat: number;
  centerLng: number;
  buildingRadiusMeters: number;
  blockRadiusMeters: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setVisible(true);
        // One-shot: the map is not torn down when it scrolls back out.
        observer.disconnect();
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref}>
      {visible ? (
        <MapPanel {...props} />
      ) : (
        // Holds the panel's ground so the footer below doesn't jump when the
        // real map swaps in. Matches MapPanel's own chrome: header row, map
        // body (h-70 / sm:h-95), legend row.
        <div
          className="h-[22.5rem] rounded-lg sm:h-[28.75rem]"
          style={{
            boxShadow: "var(--shadow-md)",
            border: "1px solid var(--border-hairline)",
            background: "var(--surface-1)",
          }}
          aria-hidden
        />
      )}
    </div>
  );
}
