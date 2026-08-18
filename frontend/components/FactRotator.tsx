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
 * cost is paid once.
 *
 * The interval stops the moment the parent unmounts this — on success when
 * results render, on failure when the error state replaces it — so a fact never
 * sits frozen behind a finished request.
 */
export function FactRotator({
  title = "Loading all complaints for this address",
  subtitle = "This happens once per address, then it’s instant for a day.",
}: {
  title?: string;
  subtitle?: string;
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
  const [start] = useState(() => Math.floor(Math.random() * NYC_FACTS.length));
  const [index, setIndex] = useState(0);

  useEffect(() => {
    // Someone who asked for less motion still needs the progress signal, so the
    // facts keep rotating — it is the cross-fade that is dropped, in CSS below.
    const id = setInterval(() => setIndex((i) => (i + 1) % NYC_FACTS.length), ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  const fact = NYC_FACTS[(start + index) % NYC_FACTS.length];

  return (
    <div className="flex flex-col items-center justify-center gap-5 px-6 py-16 text-center">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent motion-reduce:animate-none"
        style={{ borderColor: "var(--border-strong)", borderTopColor: "transparent" }}
        aria-hidden="true"
      />

      <div>
        <p className="text-sm font-semibold text-[color:var(--text-primary)]">{title}</p>
        <p className="mt-1 text-xs text-[color:var(--text-muted)]">{subtitle}</p>
      </div>

      {/* aria-live, but the label above is not: a screen reader should hear what
          is happening once, then only the facts as they change. */}
      <p
        key={index}
        aria-live="polite"
        suppressHydrationWarning
        className="rise max-w-sm text-sm leading-relaxed text-[color:var(--text-secondary)] motion-reduce:animate-none"
      >
        {fact}
      </p>
    </div>
  );
}
