"use client";

import { AddressSearch } from "./AddressSearch";
import { MapPanelLazy } from "./MapPanelLazy";
import { ScorePanelCard } from "./ScorePanelCard";
import { VerdictBanner } from "./VerdictBanner";
import { useCoords, usePrefetchTrends, useReport } from "@/lib/hooks";
import { BuildingIcon, BlockIcon, SpinnerIcon } from "./icons";

export function CompareColumn({
  label,
  initialAddress,
  onAddressChange,
}: {
  label: string;
  initialAddress: string;
  onAddressChange: (address: string, placeId?: string) => void;
}) {
  const address = initialAddress;

  // Same two hooks the report page uses, so comparing an address you already
  // looked up costs nothing — and comparing an address against ITSELF issues
  // one request, not two.
  const { data: coords, error: coordsError } = useCoords(address);
  const { data: report, error: reportError } = useReport(coords);

  usePrefetchTrends(coords);

  const failure = coordsError ?? reportError;
  const error = failure
    ? failure instanceof Error
      ? failure.message
      : "Something went wrong"
    : null;

  return (
    <div className="flex flex-col gap-4">
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

      {!address && (
        <p
          className="rounded-xl border border-dashed p-6 text-center text-sm text-(--text-muted)"
          style={{ borderColor: "var(--border-hairline)" }}
        >
          Choose an address to see its scores.
        </p>
      )}

      {error && <p style={{ color: "var(--status-critical)" }}>{error}</p>}

      {address && !report && !error && (
        <div
          className="flex h-96 items-center justify-center rounded-xl"
          style={{ background: "var(--gridline)" }}
        >
          <SpinnerIcon className="h-8 w-8 text-(--brand)" />
        </div>
      )}

      {report && coords && (
        <>
          <VerdictBanner
            building={report.buildingHealth}
            block={report.blockQuality}
            address={address}
            windowMonths={report.meta.windowMonths}
          />
          <ScorePanelCard
            icon={<BuildingIcon className="h-4.5 w-4.5" />}
            title="Building Health"
            panel={report.buildingHealth}
            colorVar="--series-building"
            description="Complaints tied to this building"
            tier="building"
            lat={coords.lat}
            lng={coords.lng}
          />
          <ScorePanelCard
            icon={<BlockIcon className="h-4.5 w-4.5" />}
            title="Block Quality"
            panel={report.blockQuality}
            colorVar="--series-block"
            description="Complaints on the surrounding block"
            tier="block"
            lat={coords.lat}
            lng={coords.lng}
          />
          <MapPanelLazy
            centerLat={coords.lat}
            centerLng={coords.lng}
            buildingRadiusMeters={report.buildingHealth.radiusMeters}
            blockRadiusMeters={report.blockQuality.radiusMeters}
          />
        </>
      )}
    </div>
  );
}
