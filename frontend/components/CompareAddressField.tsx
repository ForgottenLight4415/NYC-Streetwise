"use client";

import { AddressSearch } from "./AddressSearch";

/**
 * The label + search box pair at the top of one compare column. Pulled out
 * of the old CompareColumn so the same markup renders both while an address
 * is still loading/missing on the other side (`CompareColumnContent`) and
 * once both sides are loaded and the page switches to the row-aligned layout
 * (`CompareAlignedBody`) — the field itself never needs to know which.
 */
export function CompareAddressField({
  label,
  initialAddress,
  onAddressChange,
}: {
  label: string;
  initialAddress: string;
  onAddressChange: (address: string, placeId?: string) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-(--text-muted)">
        {label}
      </p>
      <AddressSearch
        size="sm"
        initialValue={initialAddress}
        placeholder="Enter an address to compare"
        onSelect={onAddressChange}
      />
    </div>
  );
}
