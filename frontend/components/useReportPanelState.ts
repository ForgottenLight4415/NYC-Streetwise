"use client";

import { useDeferredValue, useState } from "react";
import { AMENITY_CATEGORIES, COMPLAINT_CATEGORIES, RADAR_LABEL } from "@/lib/categories";
import { TREND_DEFAULT_MONTHS, type TrendWindow } from "@/lib/api";
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
export function useReportPanelState(report: ReportResponse) {
  const [months, setMonths] = useState<TrendWindow>(
    TREND_DEFAULT_MONTHS as TrendWindow,
  );
  const deferredMonths = useDeferredValue(months);

  // Which amenity bucket's "see all instances" modal is open, if any. Lifted
  // to this hook rather than living inside a card because several sibling
  // cards can each request it and only one may be open at a time. `tier` is
  // the wire id (e.g. "transit"), matching what
  // AmenityBrowserModal/useNearbyAmenities expect; `colorVar` lets that
  // modal's own map tint its pins and radius ring the same color as the card
  // that opened it.
  //
  // No amenity fetch here any more: the instances are needed by the modal
  // alone (for its list AND the map it now carries), so it fetches them
  // itself. This hook used to fetch them too, purely to hand the report
  // page's map a set of extra markers — a repaint of a card the open modal
  // was covering. See AmenityBrowserModal's and MapPanel's doc comments.
  const [openAmenity, setOpenAmenity] = useState<{
    tier: CategoryId;
    bucket: string;
    colorVar: string;
    label: string;
  } | null>(null);

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
    amenityCats,
    rings,
    radarAxes,
    showRadar,
  };
}
