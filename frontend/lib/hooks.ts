"use client";

import { useEffect } from "react";
import useSWR, { preload } from "swr";
import useSWRImmutable from "swr/immutable";
import {
  COMPLAINTS_FETCH_LIMIT,
  TREND_MAX_MONTHS,
  fetchAmenityNearby,
  fetchExplanation,
  fetchNearbyComplaints,
  fetchReport,
  fetchSuggestions,
  fetchTrend,
  getLatLng,
} from "./api";
import type {
  AmenityNearbyResponse,
  AutocompleteSuggestion,
  CategoryId,
  CategoryKey,
  Complaint,
  ComplaintTierId,
  ExplanationSource,
  ReportResponse,
  TrendPoint,
} from "./types";

/**
 * The app's data layer, on SWR.
 *
 * Every one of these was previously a hand-rolled `useEffect` + `useState` pair
 * that re-fetched on every mount. Three things change by moving them here:
 *
 *  1. **Dedup.** Two ScorePanelCards, two CompareColumns, and three
 *     AddressSearch instances share a cache, so the same address is fetched
 *     once no matter how many components ask for it.
 *  2. **The waterfall breaks.** Each hook fires as soon as *its own* inputs
 *     exist, rather than when the component above it finished awaiting
 *     something unrelated. See ReportView for the shape that used to be.
 *  3. **The staleness tagging goes away.** The `{ key, items }` pattern these
 *     replace existed to stop a previous address's results rendering under a
 *     new one; SWR keys do that structurally.
 *
 * `useSWRImmutable` everywhere except suggestions: scores, trends and complaint
 * histories are snapshots of a municipal dataset with a 24h server-side cache
 * behind them. Revalidating them on window focus would spend a Socrata call to
 * redraw the identical chart.
 */

type Coords = { lat: number; lng: number };

/**
 * SWR retries failed fetches five times with backoff by default. That is the
 * wrong behaviour for this app and had to be turned off explicitly.
 *
 * /api/score answers 503 to mean "NYC's data service is unavailable right now",
 * and the UI has a written message for exactly that which tells the reader to
 * try again shortly. Retrying behind their back replaces that message with a
 * spinner for the length of the backoff — half a minute of the page claiming to
 * be loading something the backend has already refused — and sends four more
 * requests at an upstream that just said it was struggling. The pre-SWR code
 * surfaced the failure on the first attempt, and that is the right call: the
 * person reading it can retry far more cheaply than a backoff loop can.
 */
const NO_RETRY = { shouldRetryOnError: false } as const;

/**
 * Geocode. Throws rather than resolving null, so "we couldn't find that
 * address" arrives as an SWR error like every other failure on this page
 * instead of as a success carrying nothing.
 */
export function useCoords(address: string, placeId?: string) {
  return useSWRImmutable<Coords>(
    address ? (["coords", address, placeId ?? null] as const) : null,
    async ([, a, p]: readonly [string, string, string | null]) => {
      const coords = await getLatLng(a, p ?? undefined);
      if (!coords) throw new Error("Couldn't locate that address.");
      return coords;
    },
    NO_RETRY,
  );
}

/** The two scores. `fetchReport` already throws with renter-readable copy. */
export function useReport(coords: Coords | undefined) {
  return useSWRImmutable<ReportResponse>(
    coords ? (["report", coords.lat, coords.lng] as const) : null,
    ([, lat, lng]: readonly [string, number, number]) => fetchReport(lat, lng),
    NO_RETRY,
  );
}

/**
 * Recent complaint points for one tier.
 *
 * Keyed independently of the score, which is the entire point: this used to be
 * awaited *before* the scores could render, even though it fills a list at the
 * bottom of the panel.
 */
export function useNearbyComplaints(
  coords: Coords | undefined,
  radius: number | undefined,
  tier: ComplaintTierId,
) {
  return useSWRImmutable<Complaint[]>(
    coords && radius
      ? (["complaints", coords.lat, coords.lng, radius, tier, COMPLAINTS_FETCH_LIMIT] as const)
      : null,
    ([, lat, lng, r, t]: readonly [string, number, number, number, ComplaintTierId, number]) =>
      fetchNearbyComplaints(lat, lng, r, t),
    NO_RETRY,
  );
}

/**
 * The 24-month series, sliced down by the caller.
 *
 * Depends only on the coordinates, never on the score response — so once
 * ReportView prefetches this key alongside /api/score, the chart is already
 * warm by the time the panel mounts.
 */
type TrendKey = readonly [string, number, number, ComplaintTierId];

const trendKey = (coords: Coords, tier: ComplaintTierId): TrendKey => [
  "trend",
  coords.lat,
  coords.lng,
  tier,
];

const trendFetcher = ([, lat, lng, t]: TrendKey) =>
  fetchTrend(lat, lng, t, TREND_MAX_MONTHS);

export function useTrend(
  coords: Coords | undefined,
  tier: ComplaintTierId,
) {
  return useSWRImmutable<TrendPoint[]>(
    coords ? trendKey(coords, tier) : null,
    trendFetcher,
    NO_RETRY,
  );
}

/**
 * Warm both tiers' trend series the moment coordinates are known.
 *
 * `preload` rather than a second `useTrend` subscription on purpose: subscribing
 * would re-render this component (and its whole subtree) when the series lands,
 * for data it does not itself display. This only fills the cache, and the
 * TrendSection that eventually mounts finds the request already in flight.
 *
 * Worth doing because the trend depends on nothing but the coordinates. Left to
 * TrendSection it cannot start until /api/score has returned and the panels have
 * mounted, so this buys back the entire score round-trip (0.3-2.5s, tail 8.3s).
 */
export function usePrefetchTrends(coords: Coords | undefined) {
  useEffect(() => {
    if (!coords) return;
    preload(trendKey(coords, "building"), trendFetcher);
    preload(trendKey(coords, "block"), trendFetcher);
  }, [coords]);
}

/**
 * The AI explanation — the slow path, deliberately off the score request.
 * `tier` is typed as the general `CategoryId`, but in practice the only
 * caller left is VerdictBanner asking for "overall": building/block/transit/
 * parks/bike/walkability each get a deterministic explanation instead (see
 * `explainFromTemplate` on the backend and the client-side amenity
 * equivalent in AmenityPanelCard), so nothing else ever calls this hook.
 *
 * Not requested at all when the section already came back as "ai": that means
 * the backend served it from its own cache, and asking again would pay model
 * latency for text we are already holding. A null key is how SWR is told to
 * sit this one out, and it reports `isLoading: false` for it, which is what
 * keeps the fully-cached case from flashing "Reasoning...".
 */
export function useExplanation(
  coords: Coords | undefined,
  tier: CategoryId,
  /** Only the two fields that decide whether a fetch is needed at all. */
  section:
    | { explanation?: string; explanationSource?: ExplanationSource }
    | undefined,
) {
  const alreadyAi = section?.explanationSource === "ai";
  const { data, isLoading } = useSWRImmutable<string | null>(
    coords && section && !alreadyAi
      ? (["explanation", coords.lat, coords.lng, tier] as const)
      : null,
    ([, lat, lng, t]: readonly [string, number, number, CategoryId]) =>
      fetchExplanation(lat, lng, t),
    NO_RETRY,
  );

  return {
    // The tier's own cached AI text wins; otherwise whatever we just fetched;
    // otherwise null, which the caller reads as "fall back to template".
    text: alreadyAi ? (section?.explanation ?? null) : (data ?? null),
    isLoading,
  };
}

/**
 * The report's one fixed-arity fanout: two useNearbyComplaints calls
 * (amenities have no complaint feed or time series to fetch). React's Rules
 * of Hooks forbid looping the category registry to build this, so this hook
 * is the one place that has to enumerate every category by hand.
 *
 * Returns a TOTAL `Record<CategoryKey, ...>` — a seventh `CategoryKey` added
 * to `lib/types.ts` without a matching line here is a *build error inside
 * this hook*, not a silent gap that shows up later as a blank panel. (This
 * is exactly how walkabilityAccess was added — the compiler caught it here
 * first.)
 *
 * No per-tier AI fetch here any more: building/block/transit/parks/bike/
 * walkability each get a deterministic "Why this score?" instead — the
 * complaint tiers' from the counts already in `report`, the amenity tiers'
 * computed client-side (see AmenityPanelCard) — so there is nothing left to
 * fetch for any of the six. `useExplanation` still exists, but only
 * VerdictBanner calls it now, for the one whole-report AI summary.
 */
export function useReportPanels(
  coords: Coords | undefined,
  report: ReportResponse | undefined,
): Record<CategoryKey, { complaints?: { data: Complaint[] | undefined; isLoading: boolean } }> {
  const buildingComplaints = useNearbyComplaints(
    coords,
    report?.buildingHealth.radiusMeters,
    "building",
  );
  const blockComplaints = useNearbyComplaints(
    coords,
    report?.blockQuality.radiusMeters,
    "block",
  );

  return {
    buildingHealth: {
      complaints: {
        data: buildingComplaints.data,
        isLoading: buildingComplaints.isLoading,
      },
    },
    blockQuality: {
      complaints: {
        data: blockComplaints.data,
        isLoading: blockComplaints.isLoading,
      },
    },
    transitAccess: {},
    parksAccess: {},
    bikeAccess: {},
    walkabilityAccess: {},
  };
}

/**
 * Every real instance of one amenity bucket within its tier's radius — what
 * backs an amenity row's `>` affordance (AmenityBrowserModal) and the map's
 * extra markers while that modal is open.
 *
 * Keyed on (coords, tier, bucket) so the SAME entry is shared — and fetched
 * only once — whether it is the modal or ReportBody (feeding MapPanel's
 * extraMarkers) that asks for it first, the same dedup `useReport`'s doc
 * comment describes for two ScorePanelCards. `tier`/`bucket` undefined
 * (nothing currently open) is how the caller says "don't fetch" — same null-
 * key convention every other hook here uses.
 */
export function useNearbyAmenities(
  coords: Coords | undefined,
  tier: CategoryId | undefined,
  bucket: string | undefined,
) {
  return useSWRImmutable<AmenityNearbyResponse>(
    coords && tier && bucket
      ? (["amenities-nearby", coords.lat, coords.lng, tier, bucket] as const)
      : null,
    ([, lat, lng, t, b]: readonly [string, number, number, CategoryId, string]) =>
      fetchAmenityNearby(lat, lng, t, b),
    NO_RETRY,
  );
}

/**
 * Address suggestions.
 *
 * The one hook here that is NOT immutable — but it is still keyed, so the
 * previous query's results can never render under the current one, which is
 * what the old `{ q, items }` pairing existed to prevent.
 *
 * Deliberately WITHOUT `keepPreviousData`: this box must never show one
 * query's suggestions under another's text, which is the bug the hand-rolled
 * `{ q, items }` pairing existed to prevent. The caller additionally gates on
 * the key matching the current input, because during the debounce window the
 * key still holds the previous query.
 *
 * The caller also still debounces before changing this key. SWR's dedup
 * collapses *identical* keys, but every keystroke is a different key, and each
 * one is a billed Places call.
 */
export function useSuggestions(query: string) {
  const { data } = useSWR<AutocompleteSuggestion[]>(
    query ? (["suggestions", query] as const) : null,
    ([, q]: readonly [string, string]) => fetchSuggestions(q),
    { revalidateOnFocus: false, ...NO_RETRY },
  );
  return data ?? EMPTY_SUGGESTIONS;
}

/** Stable identity, so a suggestion-less render doesn't churn downstream deps. */
const EMPTY_SUGGESTIONS: AutocompleteSuggestion[] = [];
