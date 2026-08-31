"use client";

import { useState } from "react";

/**
 * The "Why this score?" expandable disclosure, shared by every score panel —
 * complaint tiers (ComplaintBreakdownBars) and amenity tiers (AmenityPanelCard)
 * alike. Deliberately just the disclosure widget: what text goes inside it is
 * tier-specific (a dominant complaint category vs. the nearest amenity), so
 * that stays with each caller rather than living here.
 *
 * An inline disclosure rather than a hover tooltip: a tooltip is unreachable
 * on a touchscreen, and centering one on a wide card runs the risk of
 * spilling off the side of the viewport. Expanding in place has neither
 * problem and needs no positioning.
 */
export function WhyThisScore({ explanation }: { explanation: string | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!explanation) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="text-xs font-semibold text-(--brand-ink)"
      >
        {expanded ? "Hide why" : "Why this score?"}
      </button>
      {expanded && (
        <p
          className="mt-2 rounded-md p-3 text-sm leading-6 text-(--text-secondary)"
          style={{ background: "var(--surface-2)" }}
        >
          {explanation}
        </p>
      )}
    </div>
  );
}
