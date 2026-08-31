import { useMemo } from "react";
import { CATEGORY_LABEL, STATUS_LABEL, STATUS_VAR } from "@/lib/score";
import type { ComplaintStatus } from "@/lib/types";
import { WhyThisScore } from "./WhyThisScore";

/**
 * Scores this close together are not meaningfully different, and the copy below
 * says one category is the "biggest"/"most-reported" — so a near-tie is broken
 * by raw count. Mirrors SCORE_TIE_MARGIN in the backend's templateExplanation.js.
 */
const SCORE_TIE_MARGIN = 10;

const STATUSES: ComplaintStatus[] = ["open", "in-progress", "closed"];

/**
 * The category most responsible for the rating.
 *
 * Prefers `bucketScores` over raw counts, because counts are not comparable
 * across categories — a block with 2,876 noise and 144 street-condition
 * complaints may still be dragged down by street condition, the citywide norms
 * for the two being an order of magnitude apart. Falls back to the largest count
 * when the API sent no scores.
 *
 * Deliberately the same rule as dominantBucket() in the backend's
 * templateExplanation.js: this disclosure sits beside that text, and two
 * different answers to "which category drove this" would read as a bug.
 */
function dominantCategory(
  counts: Record<string, number>,
  bucketScores?: Record<string, number | undefined>,
): string | null {
  const categories = Object.keys(counts);
  if (categories.length === 0) return null;

  const byCount = (candidates: string[]) =>
    candidates.reduce((most, c) =>
      (counts[c] ?? 0) > (counts[most] ?? 0) ? c : most,
    );

  const scored = bucketScores
    ? categories.filter((c) => Number.isFinite(bucketScores[c]))
    : [];
  if (scored.length > 0) {
    const worst = Math.min(...scored.map((c) => bucketScores![c] as number));
    return byCount(
      scored.filter(
        (c) => (bucketScores![c] as number) - worst <= SCORE_TIE_MARGIN,
      ),
    );
  }

  return byCount(categories);
}

/** "Heat / Hot Water" -> "heat/hot water", for use mid-sentence. */
function lower(label: string) {
  return label.toLowerCase().replace(/ \/ /g, "/");
}

function plural(n: number) {
  return n === 1 ? "complaint" : "complaints";
}

/**
 * The "Why this score?" copy for one panel.
 *
 * Zero counts are handled FIRST, and are not an edge case: the backend's notes
 * record that 9 of 10 sampled coordinates have no building complaints at all
 * inside the 25m radius, and that this is real — all three building types are
 * >99.99% geocoded. So the commonest thing this says is "nothing was filed", and
 * it has to read as a clean record rather than as missing data.
 */
function explain(
  tier: "building" | "block",
  score: number,
  counts: Record<string, number>,
  bucketScores?: Record<string, number | undefined>,
): string {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  if (total === 0) {
    return tier === "building"
      ? "Nothing was filed against this building in the window - no heat or hot water outages, no plumbing failures, no unsanitary conditions. That is a real clean record, not missing data."
      : "Nothing was filed on this block in the window — no noise, parking, or street-condition complaints. That is a real clean record, not missing data.";
  }

  const category = dominantCategory(counts, bucketScores);
  if (!category) {
    return tier === "building"
      ? "This building's complaint history is too thin to point at any one issue."
      : "This block's complaint history is too thin to point at any one issue.";
  }

  const name = CATEGORY_LABEL[category] ?? category;
  const count = counts[category] ?? 0;

  if (tier === "building") {
    if (score >= 75) {
      return `This building scores well because complaints against it are rare. ${name} is the most-reported issue at ${count} ${plural(count)}, which is still low for a NYC building.`;
    }
    if (score >= 50) {
      return `This building lands mid-range: ${lower(name)} is its most-reported issue, at ${count} ${plural(count)} in the window — enough to notice, not enough to dominate.`;
    }
    return `This building is underperforming mainly on ${lower(name)} — ${count} ${plural(count)} in the window, filed often enough to pull the score down. Worth asking the landlord about directly.`;
  }

  if (score >= 75) {
    return count <= 1
      ? `This block scores well because complaints are very low overall, with only a minor ${lower(name)} issue driving the score.`
      : `This block scores well because neighborhood issues are limited. ${name} is the largest driver, but it is still low enough that the overall block quality remains strong.`;
  }
  if (score >= 50) {
    return `This block is in the middle range because ${lower(name)} is the biggest complaint type, even though total complaints are not extreme.`;
  }
  return `This block is underperforming mainly because ${lower(name)} is the dominant issue, and it is showing up often enough to pull the score down.`;
}

/**
 * A compact, narrow, status-segmented bar for one category: open/in-progress/
 * closed sized by their share of that category's total, all pre-computed
 * server-side (see `bucketStatusCounts` on ScoreSection in lib/types.ts) — this
 * component only renders the numbers it is given, never infers or re-groups.
 *
 * The track itself (the flat `--gridline` pill) always renders, even at zero
 * complaints — a category with nothing to segment still gets a visible gray
 * bar in the same lane every other category's bar occupies, rather than
 * empty space that reads as a layout gap.
 */
function StatusSegments({
  count,
  statusCounts,
}: {
  count: number;
  statusCounts: Record<ComplaintStatus, number>;
}) {
  return (
    <div
      className="h-1.5 w-full min-w-10 flex-1 overflow-hidden rounded-full"
      style={{ background: "var(--gridline)" }}
    >
      {count > 0 && (
        <div className="flex h-full w-full">
          {STATUSES.filter((s) => statusCounts[s] > 0).map((s) => (
            <span
              key={s}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{
                width: `${(statusCounts[s] / count) * 100}%`,
                background: `var(${STATUS_VAR[s]})`,
              }}
            >
              <span className="sr-only">
                {statusCounts[s]} {STATUS_LABEL[s]}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The open/in-progress/closed color key for `StatusSegments`' bars — shown
 *  once per card, not per row, since every row in a card shares one key. */
function StatusLegend() {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-(--text-muted)">
      {STATUSES.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: `var(${STATUS_VAR[s]})` }}
          />
          {STATUS_LABEL[s]}
        </li>
      ))}
    </ul>
  );
}

export function ComplaintBreakdownBars({
  counts,
  tier,
  score,
  bucketScores,
  bucketStatusCounts,
}: {
  counts: Record<string, number>;
  colorVar: string;
  /** Which panel this is. Keyed on the tier rather than the display label,
   *  which is what previously gated this to Block Quality — renaming a panel
   *  would have silently dropped the feature. */
  tier: "building" | "block";
  score?: number;
  /** Per-category scores from /api/score, when available. See dominantCategory. */
  bucketScores?: Record<string, number | undefined>;
  /**
   * Per-category open/in-progress/closed breakdown from /api/score, when
   * available. OPTIONAL: absent on an old 24h-TTL cache doc from before this
   * field shipped, or on the mock path if it wasn't wired up. A category
   * missing from this map falls back to the plain label+count row rather than
   * showing an empty or invented bar.
   */
  bucketStatusCounts?: Record<string, Record<ComplaintStatus, number> | undefined>;
}) {
  const entries = Object.entries(counts);

  const explanation = useMemo(
    () =>
      typeof score === "number"
        ? explain(tier, score, counts, bucketScores)
        : null,
    [tier, score, counts, bucketScores],
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div>
        {entries.map(([cat, count]) => {
          const statusCounts = bucketStatusCounts?.[cat];
          return (
            <div
              key={cat}
              className="flex items-center gap-3 py-1 text-sm"
            >
              <span className="w-40 min-w-0 shrink-0 truncate text-(--text-secondary)">
                {CATEGORY_LABEL[cat]}
              </span>
              {/* Only a truly absent `statusCounts` (an old pre-status cache
                  doc) falls back to a bare spacer — StatusSegments itself
                  now draws a flat gray track at zero complaints, so every
                  count still lines up at the same far-right edge. */}
              {statusCounts ? (
                <StatusSegments count={count} statusCounts={statusCounts} />
              ) : (
                <span className="flex-1" />
              )}
              <span className="font-data min-w-9 shrink-0 whitespace-nowrap text-right text-(--text-primary)">
                {count}
              </span>
            </div>
          );
        })}
      </div>

      {bucketStatusCounts && <StatusLegend />}

      <WhyThisScore explanation={explanation} />
    </div>
  );
}
