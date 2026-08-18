import { STATUS_LABEL, STATUS_VAR } from "@/lib/score";
import { useDialog } from "@/lib/useDialog";
import type { Complaint, ComplaintTimeline } from "@/lib/types";
import { CloseIcon } from "./icons";

function formatDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ComplaintDetailModal({
  complaint,
  timeline,
  onClose,
}: {
  complaint: Complaint;
  timeline: ComplaintTimeline;
  onClose: () => void;
}) {
  // Escape, focus trap, focus restore and scroll lock all come from here.
  const panelRef = useDialog(onClose);

  const latest = timeline.events[timeline.events.length - 1];

  return (
    <div
      // Above the search panel (z-50), which is itself above the header (z-40).
      // z-70, above the complaints browser (z-60) that can open this.
      className="fixed inset-0 z-70 flex items-center justify-center p-4"
      style={{ background: "color-mix(in srgb, black 50%, transparent)" }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        // On the PANEL, not the backdrop: on the backdrop it made the entire
        // viewport the dialog, so assistive tech announced the whole page.
        role="dialog"
        aria-modal="true"
        aria-label={`${complaint.label} complaint details`}
        // dvh, not vh: on mobile Safari, 80vh is measured against the *expanded*
        // viewport, so with the URL bar showing the dialog ran under it.
        className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-[var(--radius-lg)] p-5 outline-none sm:p-6"
        style={{ background: "var(--surface-1)", boxShadow: "var(--shadow-lg)", border: "1px solid var(--border-hairline)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-[color:var(--text-primary)]">{complaint.label}</h2>
            <p className="text-xs text-[color:var(--text-muted)]">Complaint #{complaint.id}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-full p-1 text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--gridline)] hover:text-[color:var(--text-primary)]"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div
          className="mb-6 flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm"
          style={{ background: `color-mix(in srgb, var(${STATUS_VAR[complaint.status]}) 12%, transparent)` }}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: `var(${STATUS_VAR[complaint.status]})` }} />
          <span className="font-medium" style={{ color: `var(${STATUS_VAR[complaint.status]}-ink)` }}>
            {STATUS_LABEL[complaint.status]}
          </span>
          {latest && (
            <span className="text-[color:var(--text-muted)]">· last updated {formatDate(latest.date)}</span>
          )}
        </div>

        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-[color:var(--text-muted)]">
          Progress timeline
        </p>
        <ol className="relative">
          {timeline.events.map((event, i) => (
            <li key={i} className="relative flex gap-3 pb-5 last:pb-0">
              {i < timeline.events.length - 1 && (
                <span
                  className="absolute left-[7px] top-4 bottom-0 w-px"
                  style={{ background: "var(--gridline)" }}
                  aria-hidden="true"
                />
              )}
              <span
                className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2"
                style={{ borderColor: `var(${STATUS_VAR[event.status]})`, background: "var(--surface-1)" }}
                aria-hidden="true"
              />
              <div className="min-w-0 pb-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium" style={{ color: `var(${STATUS_VAR[event.status]}-ink)` }}>
                    {STATUS_LABEL[event.status]}
                  </span>
                  <span className="text-xs text-[color:var(--text-muted)]">{formatDate(event.date)}</span>
                </div>
                {event.note && (
                  <p className="mt-0.5 text-sm text-[color:var(--text-secondary)]">{event.note}</p>
                )}
              </div>
            </li>
          ))}
        </ol>

        <p className="mt-2 text-[10px] text-[color:var(--text-muted)]">
          Status history is estimated from the complaint&apos;s submission date and current status — NYC 311 doesn&apos;t
          expose a full change log yet.
        </p>
      </div>
    </div>
  );
}
