import { useMemo, useState } from "react";
import { CATEGORY_LABEL } from "@/lib/score";

export function ComplaintBreakdownBars({
  counts,
  panelLabel,
  score,
}: {
  counts: Record<string, number>;
  colorVar: string;
  panelLabel?: string;
  score?: number;
}) {
  const entries = Object.entries(counts);
  const [expanded, setExpanded] = useState(false);

  const explanation = useMemo(() => {
    if (!panelLabel || panelLabel !== "Block Quality" || typeof score !== "number") {
      return null;
    }

    const sorted = [...entries].sort((a, b) => b[1] - a[1]);
    const top = sorted[0];
    const total = entries.reduce((sum, [, count]) => sum + count, 0);

    if (!top) {
      return "This block has very little neighborhood complaint activity, which keeps its quality score strong.";
    }

    const [category, count] = top;
    const categoryName = CATEGORY_LABEL[category] ?? category;

    if (score >= 75) {
      return count <= 1
        ? `This block scores well because complaints are very low overall, with only a minor ${categoryName.toLowerCase()} issue driving the score.`
        : `This block scores well because neighborhood issues are limited. ${categoryName} is the largest driver, but it is still low enough that the overall block quality remains strong.`;
    }

    if (score >= 50) {
      return `This block is in the middle range because ${categoryName.toLowerCase()} is the biggest complaint type, even though total complaints are not extreme.`;
    }

    if (total === 0) {
      return "This block is performing poorly because the complaint profile is concentrated in recurring neighborhood issues, especially around daily livability problems.";
    }

    return `This block is underperforming mainly because ${categoryName.toLowerCase()} is the dominant issue, and it is showing up often enough to pull the score down.`;
  }, [entries, panelLabel, score]);

  return (
    <div className="flex flex-col gap-2.5">
      <div>
        {entries.map(([cat, count]) => (
          <div key={cat} className="flex items-center justify-between gap-3 py-1 text-sm">
            <span className="min-w-0 truncate text-[color:var(--text-secondary)]">
              {CATEGORY_LABEL[cat]}
            </span>
            <span className="font-data shrink-0 text-[color:var(--text-primary)]">{count}</span>
          </div>
        ))}
      </div>

      {/* An inline disclosure rather than the hover tooltip this used to be.
          The tooltip was unreachable on a touchscreen, and because it was
          centered on the card at up to 30rem wide, the right-hand panel's copy
          ran off the side of the viewport. Expanding in place has neither
          problem and needs no positioning. */}
      {explanation && (
        <div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="text-xs font-semibold text-[color:var(--brand-ink)]"
          >
            {expanded ? "Hide why" : "Why this score?"}
          </button>
          {expanded && (
            <p
              className="mt-2 rounded-[var(--radius-md)] p-3 text-sm leading-6 text-[color:var(--text-secondary)]"
              style={{ background: "var(--surface-2)" }}
            >
              {explanation}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
