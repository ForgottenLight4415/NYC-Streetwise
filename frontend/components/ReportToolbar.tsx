import Link from "next/link";

/**
 * The page-layout report's sticky title bar: the address (moved here from
 * VerdictBanner, which drops its own heading when this is present - see
 * `showAddress` there) and the compare entry point that used to live in the
 * address bar above. The trend window that used to sit here is per card now
 * (ScorePanelCard): it only ever changed the two trend charts.
 *
 * Sticky from `sm` up only. On a phone the app header plus this bar, stacked
 * into a column, held 233px of an 844px screen (28%) the whole way down the
 * report, so below `sm` it scrolls away with the page.
 *
 * `sm:top-16` sits just below the app header (`h-16`, `z-40`); `sm:z-30` keeps
 * it under the search panel (50), complaints browser (60) and complaint detail
 * (70) in the z-ladder documented in globals.css.
 *
 * The `-mx-4 sm:-mx-6` bleed cancels `<main>`'s own side padding so the
 * `border-b` spans the full viewport width - correct below `xl`, where the
 * main column IS the full page width. At `xl` and up, `ReportBody` puts a
 * 360px right rail beside this column, and the bleed would overflow past the
 * main column's own grid track into the gap/rail (by exactly the outer page
 * padding, more than the gap itself) - `xl:mx-0 xl:px-0` cancels the bleed
 * there so the border stops at the main column's real edge instead.
 */
export function ReportToolbar({ address }: { address: string }) {
  return (
    <div
      className="-mx-4 mb-4 flex flex-col gap-3 border-b px-4 py-3 backdrop-blur sm:sticky sm:top-16 sm:z-30 sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6 xl:mx-0 xl:px-0"
      style={{
        background: "color-mix(in srgb, var(--background) 85%, transparent)",
        borderColor: "var(--border-hairline)",
      }}
    >
      <div className="min-w-0">
        <h1 className="truncate font-display text-xl font-semibold text-(--text-primary) sm:text-2xl">
          {address}
        </h1>
      </div>

      <Link
        href={`/compare?a=${encodeURIComponent(address)}`}
        className="inline-flex h-11 shrink-0 items-center justify-center self-start rounded-full px-5 text-sm font-semibold transition-colors sm:self-auto"
        style={{ background: "var(--brand-tint)", color: "var(--brand-ink)" }}
      >
        Compare with another
      </Link>
    </div>
  );
}
