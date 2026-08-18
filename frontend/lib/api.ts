import type {
  AutocompleteSuggestion,
  Complaint,
  ComplaintGroup,
  ComplaintPage,
  ComplaintStatus,
  ReportResponse,
  TrendPoint,
} from "./types";

// Geocoding (via /api/geocode, Google under the hood) can return zero
// results whenever a unit designator — apt/unit/suite/floor/room/# — is
// present, even though the building itself geocodes fine. Since scoring
// only needs the building's coordinates, strip these before falling back
// to a second lookup.
function stripUnit(address: string): string {
  return address
    .replace(/[,\s]*#\s*[\w-]+/g, "")
    .replace(
      /[,\s]*\b(apt|apartment|unit|suite|ste|fl|floor|rm|room|ph|penthouse|no)\.?\s*[\w-]+/gi,
      ""
    )
    .replace(/\s*,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
  const res = await fetch(`/api/geocode?address=${encodeURIComponent(query)}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (typeof data.lat !== "number" || typeof data.lng !== "number") return null;
  return { lat: data.lat, lng: data.lng };
}

async function geocodeByPlaceId(placeId: string): Promise<{ lat: number; lng: number } | null> {
  const res = await fetch(`/api/geocode?placeId=${encodeURIComponent(placeId)}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (typeof data.lat !== "number" || typeof data.lng !== "number") return null;
  return { lat: data.lat, lng: data.lng };
}

export async function getLatLng(address: string, placeId?: string): Promise<{ lat: number; lng: number } | null> {
  if (placeId) {
    const result = await geocodeByPlaceId(placeId);
    if (result) return result;
  }

  const trimmed = address.trim();
  const result = await geocode(trimmed);
  if (result) return result;

  const stripped = stripUnit(trimmed);
  if (stripped && stripped !== trimmed) return geocode(stripped);
  return null;
}

/**
 * 200 rather than the backend's nominal COMPLAINTS_DEFAULT_LIMIT of 1000.
 *
 * Not a Socrata size limit. Measured across 12 locations on 2026-08-17, a cold
 * `within_circle` query runs anywhere from 0.4s to 33.1s with no stable
 * relationship to row count, to warmth, or to location — re-running the same
 * query immediately after was sometimes SLOWER. Since size is not what costs,
 * a small page is simply the least we can ask for while still filling the
 * panel, and it keeps this list dependable on the report's critical path.
 *
 * Neither the trend chart nor the complaints browser depends on it: the first
 * aggregates by month server-side, the second by day.
 */
export const COMPLAINTS_FETCH_LIMIT = 200;

/** Reads the paging headers the backend exposes via Access-Control-Expose-Headers. */
function pageMeta(res: Response, fallbackTotal: number) {
  const total = Number(res.headers.get("X-Complaints-Total"));
  return {
    total: Number.isFinite(total) && total > 0 ? total : fallbackTotal,
    hasMore: res.headers.get("X-Complaints-Has-More") === "true",
    truncated: res.headers.get("X-Complaints-Truncated") === "true",
  };
}

interface RawPoint {
  type: string;
  lat: number;
  lng: number;
  created_date: string;
  status: string;
  statusBucket: ComplaintStatus;
}

function toComplaint(p: RawPoint, index: number, offset = 0): Complaint {
  return {
    // The offset is part of the id, not just the index: without it, page 2's
    // first row collides with page 1's first row and React reuses the wrong
    // node.
    id: `${p.type}-${p.created_date}-${offset + index}`,
    label: p.type,
    date: p.created_date?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    // Straight from the backend. The eight raw 311 status values are mapped in
    // constants.js; a second mapping here would be free to drift, and the one
    // this replaced had drifted — it filed "Assigned" and "Started" as open.
    status: p.statusBucket ?? "open",
  };
}

/**
 * Complaint points for one tier, newest first.
 *
 * `tier` matters as much as `radius`. Without it the endpoint returns every
 * complaint type from both tiers, and since noise alone can fill the row limit
 * inside a 25m circle, the building types get crowded out — the Building Health
 * panel would list noise complaints that contribute nothing to its score.
 *
 * A tier can still exceed the cap on a dense block, which is why the caller
 * labels the list as "most recent only" rather than implying completeness.
 */
export async function fetchNearbyComplaints(
  lat: number,
  lng: number,
  radius: number,
  tier: "building" | "block",
  limit = COMPLAINTS_FETCH_LIMIT
): Promise<Complaint[]> {
  const url = `${API_BASE_URL}/api/complaints?lat=${lat}&lng=${lng}&radius=${radius}&limit=${limit}&tier=${tier}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const points: RawPoint[] = await res.json();
    return points.map((p, i) => toComplaint(p, i));
  } catch {
    return [];
  }
}

/** Page sizes the complaints browser offers, mirroring the backend. */
export const COMPLAINTS_PAGE_SIZES = [25, 50, 100, 200] as const;

/** The three status buckets, in the order the browser lists them. */
export const COMPLAINT_STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "in-progress", label: "In Progress" },
  { value: "closed", label: "Closed" },
] as const;

/**
 * One page of day+type groups for the complaints browser.
 *
 * The FIRST call for an address fills a 24h server-side cache and was measured
 * at 2.3-74.3s; every call after it is a Mongo read. That is why this is opt-in
 * (`complete=1`) and never runs on report load — and why the caller shows a
 * real loading view rather than a spinner.
 *
 * `total` counts GROUPS, not the complaints inside them.
 */
export async function fetchComplaintGroups(
  lat: number,
  lng: number,
  tier: "building" | "block",
  radius: number,
  {
    months,
    bucket,
    status,
    offset = 0,
    limit = 25,
  }: {
    months?: number;
    bucket?: string;
    status?: ComplaintStatus;
    offset?: number;
    limit?: number;
  } = {}
): Promise<ComplaintPage<ComplaintGroup>> {
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    radius: String(radius),
    tier,
    complete: "1",
    offset: String(offset),
    limit: String(limit),
  });
  if (months) params.set("months", String(months));
  if (bucket) params.set("bucket", bucket);
  if (status) params.set("status", status);

  // Network failures reject with the platform's own TypeError ("Failed to
  // fetch"), which is not something to show a renter. Both paths converge on
  // one message the caller can render as-is.
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/complaints?${params}`);
  } catch {
    throw new Error("Couldn't load the full complaint history.");
  }
  if (!res.ok) throw new Error("Couldn't load the full complaint history.");
  const items: ComplaintGroup[] = await res.json();
  return { items, ...pageMeta(res, items.length) };
}

/** The individual complaints behind one group. Paginated: the largest measured group is 4,978. */
export async function fetchGroupDetail(
  lat: number,
  lng: number,
  tier: "building" | "block",
  { day, type, status, offset = 0, limit = 50 }: {
    day: string;
    type: string;
    status?: ComplaintStatus;
    offset?: number;
    limit?: number;
  }
): Promise<ComplaintPage<Complaint>> {
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    tier,
    day,
    type,
    offset: String(offset),
    limit: String(limit),
  });
  if (status) params.set("status", status);

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/complaints/group?${params}`);
  } catch {
    throw new Error("Couldn't load these complaints.");
  }
  if (!res.ok) throw new Error("Couldn't load these complaints.");
  const points: RawPoint[] = await res.json();
  const items = points.map((p, i) => toComplaint(p, i, offset));
  return { items, ...pageMeta(res, items.length) };
}

/** Windows the trend chart offers, mirroring TREND_WINDOW_OPTIONS on the backend. */
export const TREND_WINDOW_OPTIONS = [3, 6, 9, 12, 18, 24] as const;

/**
 * Nine months: long enough to cover a full heating season and a summer — the
 * two signals that actually differ between apartments — without pulling in
 * history from two tenants ago. Also the fastest window to query.
 */
export const TREND_DEFAULT_MONTHS = 9;

export type TrendWindow = (typeof TREND_WINDOW_OPTIONS)[number];

/**
 * The chart always fetches this span and slices down.
 *
 * Every window is a suffix of a longer one, so one 24-month request answers all
 * six — and it collapses the server's trend cache from up to six documents per
 * address+tier to one.
 */
export const TREND_MAX_MONTHS = 24;

/**
 * Complaints per month for one tier, oldest first, gap-free.
 *
 * Unlike fetchNearbyComplaints this cannot be truncated: Socrata does the
 * month bucketing server-side, so the response is one row per month whether
 * the location has 12 complaints or 12,000.
 */
export async function fetchTrend(
  lat: number,
  lng: number,
  tier: "building" | "block",
  months: number = TREND_DEFAULT_MONTHS
): Promise<TrendPoint[]> {
  const url = `${API_BASE_URL}/api/trend?lat=${lat}&lng=${lng}&tier=${tier}&months=${months}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.points) ? data.points : [];
  } catch {
    return [];
  }
}

/**
 * The SLOW path. Only worth calling for a tier whose /api/score response came
 * back with explanationSource "template".
 *
 * Returns null whenever there is nothing to swap in — a network failure, or the
 * endpoint answering 200 with template text because the AI call failed
 * server-side. Callers treat null as "fall back to the client-side copy", so
 * this never throws.
 */
export async function fetchExplanation(
  lat: number,
  lng: number,
  tier: "building" | "block"
): Promise<string | null> {
  const url = `${API_BASE_URL}/api/explanation?lat=${lat}&lng=${lng}&tier=${tier}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.explanationSource === "ai" && data.explanation ? data.explanation : null;
  } catch {
    return null;
  }
}

export async function fetchSuggestions(
  query: string,
  signal?: AbortSignal
): Promise<AutocompleteSuggestion[]> {
  if (!query.trim()) return [];
  const res = await fetch(`/api/autocomplete?q=${encodeURIComponent(query)}`, {
    signal,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.suggestions ?? [];
}

// Same-origin API routes (/api/geocode, /api/autocomplete) don't need this —
// only the calls below, which hit the separately-deployed Express backend.
// Trailing slash stripped: a doubled "//" here gets 308-redirected by
// Vercel's edge, and that redirect response carries no CORS headers, so the
// browser blocks it as a CORS failure before ever following it.
const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001").replace(/\/+$/, "");

export async function fetchReport(lat: number, lng: number): Promise<ReportResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lng }),
    });
  } catch {
    throw new Error("Couldn't reach the backend — is it running?");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 503) {
      throw new Error("NYC's data service is unavailable right now — try again shortly.");
    }
    throw new Error(body.details ?? body.error ?? "Failed to load report");
  }

  return res.json();
}
