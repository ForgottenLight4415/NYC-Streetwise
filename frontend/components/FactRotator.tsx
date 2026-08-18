"use client";

import { useEffect, useState } from "react";
import { NYC_FACTS } from "@/lib/nyc-facts";

/** Long enough to read a line without hurrying, short enough to feel alive. */
const ROTATE_MS = 3500;

/**
 * The loading view for a wait long enough that a spinner would read as a hang.
 *
 * Used for the complaints browser's first open (measured 2.3-74.3s) and for the
 * report itself, which serially awaits a geocode, /api/score, and two complaint
 * fetches before it can render anything. Both are long, variable, and impossible
 * to show progress for, so the wait gets something to read instead.
 *
 * The copy is a prop because only the caller knows what is being waited on; the
 * defaults keep the complaints browser's wording, including its promise that the
 * cost is paid once. `facts` and `showSpinner` are props for the same reason —
 * the homepage's hero card waits on something the user did not ask for, so it
 * rotates renting facts with no spinner.
 *
 * The interval stops the moment the parent unmounts this — on success when
 * results render, on failure when the error state replaces it — so a fact never
 * sits frozen behind a finished request.
 */
export function FactRotator({
  title = "Loading all complaints for this address",
  subtitle = "This happens once per address, then it’s instant for a day.",
  facts = NYC_FACTS,
  showSpinner = true,
  className = "gap-5 px-6 py-16",
}: {
  title?: string;
  subtitle?: string;
  /** Which list to rotate. Defaults to the NYC facts the report waits use. */
  facts?: readonly string[];
  /**
   * Spacing for the container. The default fills a page or a dialog; the hero
   * card passes something tighter because it has to occupy the same box as the
   * card it stands in for, or the section below it shifts when the real one
   * lands.
   */
  className?: string;
  /**
   * A spinner is right for a wait the user asked for. It is wrong for one they
   * did not — the homepage's hero card fills itself in while the rest of the
   * page is already usable, and a spinner there would claim the page was still
   * loading. Hence the opt-out.
   */
  showSpinner?: boolean;
}) {
  // Walks the list in order from a random starting point, so two loads in a
  // session don't open on the same fact. The offset is drawn in a lazy useState
  // initializer — evaluated once on mount rather than on every render, which is
  // what keeps the render itself pure.
  //
  // That randomness runs on the server too, now that this is the report route's
  // Suspense fallback and gets pre-rendered: the server picks one fact and the
  // client picks another, which is a hydration mismatch by construction. The
  // paragraph below is marked suppressHydrationWarning for exactly that reason —
  // the two texts are *meant* to differ, and which fact greets you is arbitrary.
  const [start] = useState(() => Math.floor(Math.random() * facts.length));
  const [index, setIndex] = useState(0);

  useEffect(() => {
    // Someone who asked for less motion still needs the progress signal, so the
    // facts keep rotating — it is the cross-fade that is dropped, in CSS below.
    const id = setInterval(
      () => setIndex((i) => (i + 1) % facts.length),
      ROTATE_MS,
    );
    return () => clearInterval(id);
  }, [facts.length]);

  const fact = facts[(start + index) % facts.length];

  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${className}`}
    >
      {showSpinner && (
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent motion-reduce:animate-none"
          style={{
            borderColor: "var(--border-strong)",
            borderTopColor: "transparent",
          }}
          aria-hidden="true"
        />
      )}

      <div>
        <p className="text-sm font-semibold text-(--text-primary)">{title}</p>
        <p className="mt-1 text-xs text-(--text-muted)">{subtitle}</p>
      </div>

      {/* aria-live, but the label above is not: a screen reader should hear what
          is happening once, then only the facts as they change. */}
      <p
        key={index}
        aria-live="polite"
        suppressHydrationWarning
        className="rise max-w-sm text-sm leading-relaxed text-(--text-secondary) motion-reduce:animate-none"
      >
        {fact}
      </p>
    </div>
  );
}
