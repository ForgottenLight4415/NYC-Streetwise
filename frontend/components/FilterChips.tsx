"use client";

/**
 * A compact radiogroup with roving tabindex, matching the trend window
 * selector's interaction exactly — arrow keys move and wrap, Tab enters and
 * leaves the whole group as one stop.
 *
 * Extracted because the complaints browser needs three of these and the trend
 * chart already had one; three hand-rolled copies would drift.
 */
export function FilterChips<T extends string | number>({
  label,
  options,
  value,
  onChange,
  suffix,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  suffix?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-full border p-0.5"
      style={{ borderColor: "var(--border-hairline)" }}
    >
      {options.map((option, i) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const step = e.key === "ArrowRight" ? 1 : options.length - 1;
              onChange(options[(i + step) % options.length].value);
            }}
            className="font-data min-h-8 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors"
            style={{
              background: selected ? "var(--surface-2)" : "transparent",
              color: selected ? "var(--text-primary)" : "var(--text-muted)",
            }}
          >
            {option.label}
          </button>
        );
      })}
      {suffix && (
        <span className="pr-1.5 text-[11px] text-(--text-muted)">
          {suffix}
        </span>
      )}
    </div>
  );
}
