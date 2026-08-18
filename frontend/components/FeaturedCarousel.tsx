"use client";

import { useEffect, useRef } from "react";
import { FeaturedCard } from "./FeaturedCard";
import type { FeaturedReport } from "@/lib/mock-data";

const SCROLL_SPEED = 0.18; // px per animation frame (~11px/s at 60fps)
const RESUME_DELAY = 2000; // ms after interaction stops before auto-scroll resumes

export function FeaturedCarousel({ reports }: { reports: FeaturedReport[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paused = useRef(false);
  const rafRef = useRef<number>(0);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Track fractional scroll position separately — browsers round scrollLeft to
  // integers on read, so `el.scrollLeft += 0.18` would never accumulate.
  const scrollPos = useRef(0);

  // Duplicate entries so we can loop seamlessly: when we reach the midpoint,
  // silently snap back to position 0 (which looks identical).
  const looped = [...reports, ...reports];

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Respected in JS, not just CSS: this is a requestAnimationFrame loop, so
    // the reduced-motion rules in globals.css cannot reach it. Anyone who has
    // asked for less motion gets a plain, manually scrollable row.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    function tick() {
      if (!paused.current && el) {
        scrollPos.current += SCROLL_SPEED;
        // Seamless loop: halfway through the duplicated list = back to start
        if (scrollPos.current >= el.scrollWidth / 2) {
          scrollPos.current = 0;
        }
        el.scrollLeft = scrollPos.current;
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    function pause() {
      paused.current = true;
      clearTimeout(resumeTimer.current);
    }

    function scheduleResume() {
      clearTimeout(resumeTimer.current);
      resumeTimer.current = setTimeout(() => {
        paused.current = false;
      }, RESUME_DELAY);
    }

    el.addEventListener("mouseenter", pause);
    el.addEventListener("mouseleave", scheduleResume);
    el.addEventListener("touchstart", pause, { passive: true });
    el.addEventListener("touchend", scheduleResume, { passive: true });
    // Sync tracked position when user scrolls manually so resume is seamless
    el.addEventListener("scroll", () => { scrollPos.current = el.scrollLeft; }, { passive: true });

    function onWheel() {
      pause();
      scheduleResume();
    }
    el.addEventListener("wheel", onWheel, { passive: true });

    return () => {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(resumeTimer.current);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="hide-scrollbar flex gap-4 overflow-x-auto py-4"
      style={{
        scrollbarWidth: "none",
        msOverflowStyle: "none",
        WebkitOverflowScrolling: "touch",
        cursor: "grab",
      }}
    >
      {looped.map((report, i) => (
        <div
          key={`${report.address}-${i}`}
          // A fixed 340px overflowed a 360px phone once the page gutters were
          // taken out. The min() keeps the desktop width and lets the card sit
          // inside the viewport on a phone, with a sliver of the next one
          // showing so the row reads as scrollable.
          className="w-[min(340px,82vw)] flex-shrink-0"
        >
          <FeaturedCard address={report.address} borough={report.borough} data={report.data} />
        </div>
      ))}
    </div>
  );
}
