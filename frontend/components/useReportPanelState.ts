"use client";

import { useDeferredValue, useState } from "react";
import { AMENITY_CATEGORIES, COMPLAINT_CATEGORIES, RADAR_LABEL } from "@/lib/categories";
import { TREND_DEFAULT_MONTHS, type TrendWindow } from "@/lib/api";
import { useNearbyAmenities } from "@/lib/hooks";
import type { CategoryId, ReportResponse } from "@/lib/types";
import type { RadarAxis } from "./ScoreRadar";

/**
 * The per-report derived data and local UI state (trend window, open amenity
 * modal) that both `ReportBody` and the compare page's `CompareAlignedBody`
 * need — pulled out here so the two don't drift, the way they already did
 * once before `RADAR_LABEL` and this fold lived only inline in `ReportBody`.
 *
 * One report per call: the compare page's aligned layout calls this twice
 * (once per address), each with its own independent trend window and open
 * amenity modal, exactly as the two separate report trees it replaces did.
 */
export function useReportPanelState(
  report: ReportResponse,
  coords: { lat: number; lng: number },
) {
  const [months, setMonths] = useState<TrendWindow>(
    TREND_DEFAULT_MONTHS as TrendWindow,
  );
  const deferredMonths = useDeferredValue(months);

  // Which amenity bucket's "see all instances" modal is open, if any — the
  // one piece of state the amenity cards and the map (both direct children
  // of the report tree, siblings of each other) need to share, so it is
  // lifted here rather than living inside either one. `tier` is the wire id
  // (e.g. "transit"), matching what AmenityBrowserModal/useNearbyAmenities
  // expect; `colorVar` lets the map tint its extra markers the same color as
  // the tier's own card and radius ring.
  const [openAmenity, setOpenAmenity] = useState<{
    tier: CategoryId;
    bucket: string;
    colorVar: string;
    label: string;
  } | null>(null);

  // Fetched here (not inside the modal alone) so the SAME instances feed both
  // the modal's list AND the map's extra markers below — SWR dedupes the
  // request regardless of which of the two mounts/asks first, same sharing
  // useReport's own doc comment describes for two ScorePanelCards.
  const nearbyAmenities = useNearbyAmenities(
    openAmenity ? coords : undefined,
    openAmenity?.tier,
    openAmenity?.bucket,
  );
  const extraMarkers =
    openAmenity && nearbyAmenities.data
      ? nearbyAmenities.data.instances.map((inst) => ({
          lat: inst.lat,
          lng: inst.lng,
          label: inst.name ?? openAmenity.label,
        }))
      : undefined;

  // Present amenity categories only — a report can have all four, none (a
  // pre-rollout showcase cache, or the amenity datasets failing to load), or
  // a subset is not currently possible server-side but would still render
  // correctly here if it ever were.
  const amenityCats = AMENITY_CATEGORIES.filter((c) => report[c.key] != null);

  const rings = [
    ...COMPLAINT_CATEGORIES.map((c) => ({
      radiusMeters: report[c.key].radiusMeters,
      colorVar: c.colorVar,
      label: c.ringLabel,
    })),
    ...amenityCats.map((c) => ({
      radiusMeters: report[c.key]!.radiusMeters,
      colorVar: c.colorVar,
      label: c.ringLabel,
    })),
  ];

  const radarAxes: RadarAxis[] = [
    ...COMPLAINT_CATEGORIES.map((c) => ({
      key: c.key,
      label: RADAR_LABEL[c.key],
      score: report[c.key].score,
      colorVar: c.colorVar,
    })),
    ...amenityCats.map((c) => ({
      key: c.key,
      label: RADAR_LABEL[c.key],
      score: report[c.key]!.score,
      colorVar: c.colorVar,
    })),
  ];
  const showRadar = radarAxes.length >= 3;

  return {
    months,
    setMonths,
    deferredMonths,
    openAmenity,
    setOpenAmenity,
    extraMarkers,
    amenityCats,
    rings,
    radarAxes,
    showRadar,
  };
}
