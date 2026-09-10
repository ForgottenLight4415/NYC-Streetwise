import { FactRotator } from "./FactRotator";

/**
 * The report's one loading view, used for BOTH waits that precede it: the
 * Suspense boundary around useSearchParams, and the fetch inside ReportView.
 *
 * Shared rather than duplicated because they run back to back. When the boundary
 * rendered a different placeholder, a cold load showed pulsing blocks for about
 * a second and then swapped to the facts - one wait that looked like two.
 *
 * Container matches the loaded report's, so nothing changes width when it lands.
 */
export function ReportLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <FactRotator
        title="Pulling this address’s 311 record"
        subtitle="Locating the address, then scoring its building and block."
      />
    </div>
  );
}
