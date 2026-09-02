"use client";

import Link from "next/link";
import { useEffect } from "react";

// Root error boundary — catches an unexpected render-time throw anywhere
// under the root layout (Header stays mounted; only this segment's content
// is replaced). This is NOT the path a documented backend failure takes:
// ReportView/CompareView already catch `fetchReport()`'s throw via SWR's
// `error` state and render their own branded message inline (see
// ReportView.tsx). This boundary only ever fires for a genuine bug, so it
// exists to avoid Next's default unstyled overlay in that rarer case.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center sm:px-6">
      <p
        className="font-display text-xl font-semibold tracking-tight"
        style={{ color: "var(--status-critical)" }}
      >
        Something went wrong
      </p>
      <p className="mt-2 text-sm text-(--text-secondary)">
        An unexpected error stopped this page from loading. It&rsquo;s on us,
        not your address.
      </p>
      <div className="mt-6 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-11 shrink-0 items-center justify-center rounded-full px-5 text-md font-semibold transition-colors"
          style={{ background: "var(--brand)", color: "#ffffff" }}
        >
          Try again
        </button>
        <Link
          href="/"
          className="text-sm underline text-(--text-secondary)"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
