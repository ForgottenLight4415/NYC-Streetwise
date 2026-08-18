"use client";

import { COMPLAINTS_PAGE_SIZES } from "@/lib/api";
import { ChevronRightIcon } from "./icons";

/** Page numbers to show, with nulls marking gaps. Always includes first and last. */
function pageWindow(current: number, last: number): (number | null)[] {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const around = [current - 1, current, current + 1].filter((p) => p > 1 && p < last);
  const pages = [1, ...around, last];
  const out: (number | null)[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (i > 0 && pages[i] - pages[i - 1] > 1) out.push(null);
    out.push(pages[i]);
  }
  return out;
}

export function Pager({
  offset,
  pageSize,
  total,
  label,
  onOffsetChange,
  onPageSizeChange,
}: {
  offset: number;
  pageSize: number;
  total: number;
  /** What is being counted, in both forms — a single day reads "1 day". */
  label: { one: string; many: string };
  onOffsetChange: (offset: number) => void;
  onPageSizeChange?: (size: number) => void;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.floor(offset / pageSize) + 1;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + pageSize, total);

  const go = (page: number) => onOffsetChange((page - 1) * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-3" style={{ borderColor: "var(--border-hairline)" }}>
      {/* Announced politely so a screen-reader user hears the new range after
          paging, rather than having to hunt for what changed. */}
      <p aria-live="polite" className="font-data text-xs text-(--text-muted)">
        {total === 0
          ? `No ${label.many}`
          : `Showing ${from}–${to} of ${total.toLocaleString()} ${total === 1 ? label.one : label.many}`}
      </p>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => go(current - 1)}
          disabled={current <= 1}
          aria-label="Previous page"
          className="flex min-h-8 min-w-8 items-center justify-center rounded-md transition-colors disabled:opacity-35 enabled:hover:bg-(--surface-2)"
        >
          <ChevronRightIcon className="h-3.5 w-3.5 rotate-180 text-(--text-secondary)" />
        </button>

        {pageWindow(current, lastPage).map((page, i) =>
          page === null ? (
            <span key={`gap-${i}`} className="px-1 text-xs text-(--text-muted)" aria-hidden="true">
              &hellip;
            </span>
          ) : (
            <button
              key={page}
              type="button"
              onClick={() => go(page)}
              aria-label={`Page ${page}`}
              aria-current={page === current ? "page" : undefined}
              className="font-data min-h-8 min-w-8 rounded-md px-1.5 text-xs font-medium transition-colors"
              style={{
                background: page === current ? "var(--surface-2)" : "transparent",
                color: page === current ? "var(--text-primary)" : "var(--text-muted)",
              }}
            >
              {page}
            </button>
          )
        )}

        <button
          type="button"
          onClick={() => go(current + 1)}
          disabled={current >= lastPage}
          aria-label="Next page"
          className="flex min-h-8 min-w-8 items-center justify-center rounded-md transition-colors disabled:opacity-35 enabled:hover:bg-(--surface-2)"
        >
          <ChevronRightIcon className="h-3.5 w-3.5 text-(--text-secondary)" />
        </button>
      </div>

      {onPageSizeChange && (
        <label className="flex items-center gap-1.5 text-xs text-(--text-muted)">
          <span>Per page</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="font-data min-h-8 rounded-md border bg-(--surface-1) px-1.5 py-1 text-xs text-(--text-primary)"
            style={{ borderColor: "var(--border-strong)" }}
          >
            {COMPLAINTS_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
