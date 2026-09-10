"use client";

import { ReportBody } from "./ReportBody";
import { SpinnerIcon } from "./icons";
import type { ReportResponse } from "@/lib/types";

/**
 * One compare column's content area, below the address field - placeholder,
 * spinner, error, or the full report, exactly what the old CompareColumn
 * rendered. Used only while at least one of the two addresses isn't loaded
 * yet; once both are, CompareView switches to CompareAlignedBody instead so
 * matching sections line up between the two columns (see its own doc).
 */
export function CompareColumnContent({
  address,
  coords,
  report,
  error,
}: {
  address: string;
  coords?: { lat: number; lng: number };
  report?: ReportResponse;
  error?: unknown;
}) {
  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : "Something went wrong"
    : null;

  return (
    <div>
      {!address && (
        <p
          className="rounded-xl border border-dashed p-6 text-center text-sm text-(--text-muted)"
          style={{ borderColor: "var(--border-hairline)" }}
        >
          Choose an address to see its scores.
        </p>
      )}

      {errorMessage && (
        <p style={{ color: "var(--status-critical)" }}>{errorMessage}</p>
      )}

      {address && !report && !errorMessage && (
        <div
          className="flex h-96 items-center justify-center rounded-xl"
          style={{ background: "var(--gridline)" }}
        >
          <SpinnerIcon className="h-8 w-8 text-(--brand)" />
        </div>
      )}

      {report && coords && (
        <ReportBody
          report={report}
          coords={coords}
          address={address}
          layout="column"
        />
      )}
    </div>
  );
}
