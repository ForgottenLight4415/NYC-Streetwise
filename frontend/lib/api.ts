import type {
  AutocompleteSuggestion,
  Complaint,
  ComplaintGroup,
  ComplaintPage,
  ComplaintStatus,
  ReportResponse,
  ShowcaseFallback,
  ShowcaseItem,
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
  /** The 311 primary key. Null on the mock path, which has no real records. */
  unique_key?: string | null;
  type: string;
  lat: number;
  lng: number;
  created_date: string;
  status: string;
  statusBucket: ComplaintStatus;
}

function toComplaint(p: RawPoint, index: number, offset = 0): Complaint {
  return {
    // Prefer the dataset's own key. The fallback stays for the mock path, which
    // has no real records: the offset is part of it, not just the index, because
    // without it page 2's first row collides with page 1's and React reuses the
    // wrong node.
    id: p.unique_key ?? `${p.type}-${p.created_date}-${offset + index}`,
    // Left undefined rather than defaulted, so the UI shows a case number only
    // when there is a real one to show.
    referenceId: p.unique_key ?? undefined,
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
 * A tier can still exceed the cap on a dense block. The caller does not warn
 * about it: it renders only the newest 5 of this newest-first list, which are
 * correct regardless, and sends anyone wanting the rest to the grouped browser
 * (fetchComplaintGroups) — a separate, far larger dataset with its own notice.
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

/**
 * A drill-in page. Unlike ComplaintPage, `total` is nullable — see below.
 */
export interface GroupDetailPage {
  items: Complaint[];
  /** Exact count when the backend could state it, else null (unknown). */
  total: number | null;
  hasMore: boolean;
  truncated: boolean;
}

/**
 * The individual complaints behind one group. Paginated: the largest measured
 * group is 4,978.
 *
 * `total` is null unless the backend could state it exactly (i.e. this is the
 * last page). That distinction matters: the caller's other number for this — the
 * group row's count — comes from a 24h cache filled from a DIFFERENT Socrata
 * snapshot, and Socrata's replicas disagree with each other about both row
 * counts and statuses. When the backend does send a total, it describes the rows
 * in this very response, so preferring it keeps the drill-in self-consistent.
 */
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
): Promise<GroupDetailPage> {
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

  // Read directly rather than via pageMeta(), which substitutes the page length
  // for a missing total — exactly the guess this caller must not make, since a
  // mid-list page would then report itself as the whole group.
  const header = Number(res.headers.get("X-Complaints-Total"));
  return {
    items,
    total: Number.isFinite(header) && header > 0 ? header : null,
    hasMore: res.headers.get("X-Complaints-Has-More") === "true",
    truncated: res.headers.get("X-Complaints-Truncated") === "true",
  };
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
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001").replace(/\/+$/, "");

export type ShowcaseMode = "top" | "recent" | "random";

/**
 * How long the homepage will wait for its cached addresses before giving up.
 *
 * The endpoint answers in ~30ms warm, so this is not a latency budget — it is a
 * cap on the ways the call can go WRONG. A backend cold start, or a Mongo
 * outage (the driver's own server-selection timeout is 8s), would otherwise sit
 * on the page render. Two and a half seconds is far outside the normal response
 * and far inside anything a visitor would tolerate staring at.
 */
const SHOWCASE_TIMEOUT_MS = 2500;

/** Nothing cached and no subject to fall back to. Shared so the shape is one thing. */
const EMPTY_SHOWCASE = { items: [] as ShowcaseItem[], fallback: null };

/**
 * Addresses the backend has already cached, named and scored — what the homepage
 * shows in place of the invented "sample reports" it used to.
 *
 * Cache-only server-side, so this is fast or empty, never slow. Returns [] on any
 * failure for the same reason fetchNearbyComplaints does: the homepage must
 * render whether or not this resolves, and fewer real cards beat a broken page.
 *
 * `init` carries Next's fetch options through — the homepage passes a revalidate
 * window so the call happens during ISR rather than on a visitor's request.
 */
export async function fetchShowcase(
  mode: ShowcaseMode = "top",
  limit = 6,
  init?: RequestInit
): Promise<{ items: ShowcaseItem[]; fallback: ShowcaseFallback | null }> {
  const url = `${API_BASE_URL}/api/showcase?mode=${mode}&limit=${limit}`;
  try {
    const res = await fetch(url, {
      // An aborted fetch rejects, and the catch below turns that into the empty
      // result — the same cold-cache path the page already handles. Overridable,
      // but every caller so far wants the cap.
      signal: AbortSignal.timeout(SHOWCASE_TIMEOUT_MS),
      ...init,
    });
    if (!res.ok) return EMPTY_SHOWCASE;
    const data = await res.json();
    return {
      items: Array.isArray(data.items) ? data.items : [],
      // Null when the backend is unreachable, which is also when a live score
      // fetch would fail — so the hero card renders nothing rather than a
      // subject it cannot score.
      fallback: data.fallback ?? null,
    };
  } catch {
    return EMPTY_SHOWCASE;
  }
}

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
