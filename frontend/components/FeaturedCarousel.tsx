"use client";

import { useEffect, useMemo, useRef } from "react";
import { FeaturedCard } from "./FeaturedCard";
import type { ShowcaseItem } from "@/lib/types";

const SCROLL_SPEED = 0.18; // px per animation frame (~11px/s at 60fps)
const RESUME_DELAY = 2000; // ms after interaction stops before auto-scroll resumes

export function FeaturedCarousel({ reports }: { reports: ShowcaseItem[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paused = useRef(false);
  const rafRef = useRef<number>(0);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Track fractional scroll position separately — browsers round scrollLeft to
  // integers on read, so `el.scrollLeft += 0.18` would never accumulate.
  const scrollPos = useRef(0);

  // Duplicate entries so we can loop seamlessly: when we reach the midpoint,
  // silently snap back to position 0 (which looks identical).
  const looped = useMemo(() => [...reports, ...reports], [reports]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Respected in JS, not just CSS: this is a requestAnimationFrame loop, so
    // the reduced-motion rules in globals.css cannot reach it. Anyone who has
    // asked for less motion gets a plain, manually scrollable row.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // The loop used to reschedule itself unconditionally for the life of the
    // page — still ticking every frame while paused, while scrolled past, and
    // while the tab was in the background. It now runs only when all three of
    // those say it should, and genuinely stops otherwise.
    let running = false;
    let onScreen = false;

    function tick() {
      if (!el) return;
      scrollPos.current += SCROLL_SPEED;
      // Seamless loop: halfway through the duplicated list = back to start
      if (scrollPos.current >= el.scrollWidth / 2) {
        scrollPos.current = 0;
      }
      el.scrollLeft = scrollPos.current;
      rafRef.current = requestAnimationFrame(tick);
    }

    function start() {
      if (running || paused.current || !onScreen || document.hidden) return;
      running = true;
      rafRef.current = requestAnimationFrame(tick);
    }

    function stop() {
      if (!running) return;
      running = false;
      cancelAnimationFrame(rafRef.current);
    }

    function pause() {
      paused.current = true;
      clearTimeout(resumeTimer.current);
      stop();
    }

    function scheduleResume() {
      clearTimeout(resumeTimer.current);
      resumeTimer.current = setTimeout(() => {
        paused.current = false;
        start();
      }, RESUME_DELAY);
    }

    function onWheel() {
      pause();
      scheduleResume();
    }

    // Sync tracked position when user scrolls manually so resume is seamless
    function onScroll() {
      if (el) scrollPos.current = el.scrollLeft;
    }

    function onVisibility() {
      if (document.hidden) stop();
      else start();
    }

    const observer = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        if (onScreen) start();
        else stop();
      },
      // A sliver counts: the row is full-bleed and tall enough that requiring
      // more would leave it frozen while partly in view.
      { threshold: 0 },
    );
    observer.observe(el);

    el.addEventListener("mouseenter", pause);
    el.addEventListener("mouseleave", scheduleResume);
    el.addEventListener("touchstart", pause, { passive: true });
    el.addEventListener("touchend", scheduleResume, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      clearTimeout(resumeTimer.current);
      observer.disconnect();
      // Every listener added above is removed here. The old cleanup cancelled
      // the frame and the timer but left these bound, which under StrictMode's
      // double-invoke meant two of each in development.
      el.removeEventListener("mouseenter", pause);
      el.removeEventListener("mouseleave", scheduleResume);
      el.removeEventListener("touchstart", pause);
      el.removeEventListener("touchend", scheduleResume);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      document.removeEventListener("visibilitychange", onVisibility);
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
          className="w-[min(340px,82vw)] shrink-0"
        >
          <FeaturedCard
            address={report.address}
            borough={report.borough}
            data={report}
          />
        </div>
      ))}
    </div>
  );
}
