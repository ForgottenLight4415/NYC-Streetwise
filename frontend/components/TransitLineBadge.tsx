type TransitLineBadgeProps = {
  /** e.g. "4", "N", "L" for subway; "M104", "Bx12" for bus. */
  route: string;
  mode: "subway" | "bus";
  className?: string;
};

/**
 * Official MTA trunk-line colors, keyed by every route letter/number on that
 * trunk — from mta.info's own service-line color reference, NOT guessed.
 * Text is white on every trunk except the yellow one (N/Q/R/W), which uses
 * dark text for contrast — both are fixed hex values, not theme tokens,
 * because these are the MTA's own brand colors and must stay identical in
 * light and dark mode, unlike the rest of this app's palette.
 */
const SUBWAY_TRUNK_COLORS: Record<string, { bg: string; fg: string }> = {};
function registerTrunk(routes: string[], bg: string, fg = "#ffffff") {
  for (const route of routes) SUBWAY_TRUNK_COLORS[route] = { bg, fg };
}
registerTrunk(["1", "2", "3"], "#EE352E"); // IRT Broadway–7th Ave
registerTrunk(["4", "5", "6"], "#00933C"); // IRT Lexington Ave
registerTrunk(["7"], "#B933AD"); // IRT Flushing
registerTrunk(["N", "Q", "R", "W"], "#FCCC0A", "#10151f"); // BMT Broadway
registerTrunk(["L"], "#A7A9AC"); // BMT Canarsie
registerTrunk(["J", "Z"], "#996633"); // BMT Nassau
registerTrunk(["A", "C", "E"], "#2850AD"); // IND 8th Ave
registerTrunk(["B", "D", "F", "M"], "#FF6319"); // IND 6th Ave
registerTrunk(["G"], "#6CBE45"); // IND Crosstown
registerTrunk(["S"], "#808183"); // Shuttles

/**
 * Defensive only — every real `daytime_routes` value from the backend's
 * subway-station join should already be a key above. Theme-aware (unlike
 * the trunk colors) since it isn't one of the MTA's own official colors.
 */
const FALLBACK_SUBWAY_COLOR = { bg: "var(--text-muted)", fg: "var(--surface-1)" };

/**
 * One subway or bus route badge — e.g. next to a "Nearest Transit" result,
 * so a rider can see at a glance which lines actually stop there.
 *
 * Subway: a filled circle in the route's official MTA trunk-line color, bold
 * letter/number centered inside — the same visual language MTA signage and
 * maps use, so "4" reads as the Lexington Ave line at a glance rather than
 * needing a legend.
 *
 * Bus: MTA has no well-known public per-route color system the way subway
 * does, so this deliberately does NOT invent official-looking colors —
 * instead a single neutral rounded-rectangle pill using the app's own
 * surface/border tokens, with the route's short name as plain text (e.g.
 * "M104", "Bx12").
 */
export function TransitLineBadge({ route, mode, className }: TransitLineBadgeProps) {
  if (mode === "bus") {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-md border border-(--border-hairline) bg-(--surface-2) px-1.5 py-0.5 text-xs font-semibold leading-none text-(--text-primary) ${className ?? ""}`}
      >
        {route}
      </span>
    );
  }

  const colors = SUBWAY_TRUNK_COLORS[route.toUpperCase()] ?? FALLBACK_SUBWAY_COLOR;

  return (
    <span
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold leading-none ${className ?? ""}`}
      style={{ backgroundColor: colors.bg, color: colors.fg }}
      aria-label={`${route} train`}
    >
      {route}
    </span>
  );
}
