import { STATUS_LABEL, STATUS_VAR } from "@/lib/score";
import { useDialog } from "@/lib/useDialog";
import type { Complaint } from "@/lib/types";
import { CloseIcon } from "./icons";

function formatDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * One complaint, showing only what 311 actually gives us: what was filed, when,
 * and where it stands now.
 *
 * There was a "progress timeline" here — Open on the filing date, then In
 * Progress, then Closed, with dates and agency notes. None of it was real. 311
 * exposes the current status and nothing else, so the intermediate steps were
 * synthesised from the filing date plus a seeded random offset, which put them
 * in the FUTURE for anything filed recently. Estimated history reads exactly
 * like recorded history, and for someone deciding on a lease that is the wrong
 * error to make, so it is gone rather than corrected.
 *
 * The "Complaint #" line is gone for the same reason: that id is built
 * client-side in toComplaint() from type + timestamp + row index, so it looked
 * like a 311 reference number while being an artifact of our own paging. The
 * dataset's real identifier (unique_key) is not currently requested from
 * Socrata; if it ever is, this is where it belongs.
 */
export function ComplaintDetailModal({
  complaint,
  onClose,
}: {
  complaint: Complaint;
  onClose: () => void;
}) {
  // Escape, focus trap, focus restore and scroll lock all come from here.
  const panelRef = useDialog(onClose);

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
          <h2 className="min-w-0 text-lg font-semibold text-[color:var(--text-primary)]">
            {complaint.label}
          </h2>
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
          className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm"
          style={{ background: `color-mix(in srgb, var(${STATUS_VAR[complaint.status]}) 12%, transparent)` }}
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: `var(${STATUS_VAR[complaint.status]})` }}
          />
          <span className="font-medium" style={{ color: `var(${STATUS_VAR[complaint.status]}-ink)` }}>
            {STATUS_LABEL[complaint.status]}
          </span>
        </div>

        <dl className="mt-5 flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-[color:var(--text-muted)]">
              Filed
            </dt>
            <dd className="font-data text-sm text-[color:var(--text-primary)]">
              {formatDate(complaint.date)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-[color:var(--text-muted)]">
              Type
            </dt>
            <dd className="min-w-0 text-right text-sm text-[color:var(--text-primary)]">
              {complaint.label}
            </dd>
          </div>
          {complaint.referenceId && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs font-medium uppercase tracking-wide text-[color:var(--text-muted)]">
                311 case
              </dt>
              <dd className="font-data text-sm text-[color:var(--text-primary)]">
                {complaint.referenceId}
              </dd>
            </div>
          )}
        </dl>

        <p className="mt-5 text-[11px] leading-relaxed text-[color:var(--text-muted)]">
          Case number, filing date and current status as recorded by NYC 311. The
          city does not publish a change log, so there is no history to show
          between the filing and where it stands now.
        </p>
      </div>
    </div>
  );
}
