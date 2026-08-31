import {
  SOCRATA_ENDPOINT,
  LOCATION_FIELD,
  RADIUS_TIERS,
  BUCKET_NAMES,
  TYPE_TO_BUCKET,
  SOCRATA_TIMEOUT_MS,
  SOCRATA_MAX_RETRIES,
  SOCRATA_ROW_LIMIT,
  COMPLAINT_FILL_TIMEOUT_MS,
  COMPLAINT_FILL_RETRIES,
  KNOWN_STATUSES,
  STATUS_BUCKET_NAMES,
  rawStatusesForBucket,
  statusBucket,
  windowCutoffISO,
} from "../config/constants.js";

/** Socrata call failed after exhausting retries. Callers decide whether to fall back to stale cache. */
export class SocrataError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = "SocrataError";
    this.status = status;
    this.cause = cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** SoQL string literals use doubled single quotes to escape. */
function soqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function typeInClause(types) {
  return `complaint_type in (${types.map(soqlString).join(",")})`;
}

/**
 * A SoQL predicate matching exactly the rows statusBucket() would file under
 * `bucket`.
 *
 * "open" is the catch-all and cannot be expressed as a simple `in` list:
 * statusBucket() maps NULL and every unrecognised value there too, so filtering
 * on the known open strings alone would silently drop rows that the grouped
 * counts DID include — which is the disagreement this whole predicate exists to
 * prevent. Matching the complement instead keeps the two paths total in the same
 * way, including for a ninth status value the dataset has not shown us yet.
 */
function statusClause(bucket) {
  const inBucket = rawStatusesForBucket(bucket).map(soqlString).join(",");
  if (bucket !== "open") return `status in (${inBucket})`;

  const known = KNOWN_STATUSES.map(soqlString).join(",");
  return `(status in (${inBucket}) OR status IS NULL OR status not in (${known}))`;
}

/**
 * Cutoff for an N-month trailing window, as a Socrata FLOATING timestamp.
 *
 * The `.slice(0, 19)` is load-bearing: the dataset's created_date has no time
 * zone, and sending a trailing "Z" makes Socrata reject the query outright.
 * Falls back to the fixed WINDOW_MONTHS cutoff when no window is given.
 */
function cutoffISO(months, now) {
  if (!months) return windowCutoffISO(now);
  const cutoff = new Date(now ?? Date.now());
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff.toISOString().slice(0, 19);
}

/**
 * One GET against the dataset with timeout + bounded retry.
 * Retries on 429 and 5xx (transient/throttle) and on network/timeout errors.
 * Does NOT retry 4xx other than 429 — a malformed SoQL query will fail
 * identically on every attempt, so retrying just delays the error.
 *
 * Exported so scripts/ can issue one-off queries (sampling, verification)
 * through the same retry and timeout policy the request path uses, instead of
 * each script hand-rolling a bare fetch. `timeoutMs` is overridable because
 * citywide aggregates are far slower than the 5s request-path budget.
 */
export async function query(
  params,
  { retries = SOCRATA_MAX_RETRIES, timeoutMs = SOCRATA_TIMEOUT_MS } = {}
) {
  const url = `${SOCRATA_ENDPOINT}?${new URLSearchParams(params)}`;
  const headers = { Accept: "application/json" };
  if (process.env.SOCRATA_APP_TOKEN) {
    headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 300ms, 900ms — jittered so concurrent requests don't retry in lockstep.
      await sleep(300 * 3 ** (attempt - 1) * (0.5 + Math.random()));
    }

    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) return res.json();

      const retryable = res.status === 429 || res.status >= 500;
      const body = (await res.text().catch(() => "")).slice(0, 300);
      lastError = new SocrataError(`socrata ${res.status}: ${body}`, {
        status: res.status,
      });
      if (!retryable) throw lastError;
    } catch (err) {
      if (err instanceof SocrataError && !(err.status === 429 || err.status >= 500)) {
        throw err;
      }
      lastError = err;
    }
  }

  throw new SocrataError(
    `socrata request failed after ${retries + 1} attempts: ${lastError?.message}`,
    { cause: lastError }
  );
}

/** Zero-filled `{open: 0, "in-progress": 0, closed: 0}` — one status breakdown. */
function zeroStatusCounts() {
  return Object.fromEntries(STATUS_BUCKET_NAMES.map((name) => [name, 0]));
}

/**
 * Counts complaints for ONE radius tier around a point: a single HTTP call that
 * groups by (complaint_type, status), whose per-string rows are then summed
 * into buckets — both a plain per-bucket total (`counts`, for scoring, exactly
 * as before) and a per-bucket status breakdown (`bucketStatusCounts`, for the
 * frontend's status-segmented category bar).
 *
 * `status` rides along in the SAME $select/$group rather than a second query —
 * still ONE HTTP call per tier, which is what CLAUDE.md's "two Socrata calls
 * per uncached address" budget depends on.
 *
 * Summing into buckets here (rather than scoring per string) is required —
 * buckets hold different numbers of string variants, so per-string averaging
 * would silently underweight noise (4 strings) against plumbing (2).
 *
 * @returns {Promise<{
 *   counts: Record<string, number>,
 *   bucketStatusCounts: Record<string, Record<"open"|"in-progress"|"closed", number>>
 * }>} `counts` is zero-filled per bucket, exactly as before. `bucketStatusCounts`
 *   is zero-filled the same way, one status breakdown per bucket.
 */
export async function fetchCountsForTier(lat, lng, tierName, { now } = {}) {
  const { radiusMeters, buckets } = RADIUS_TIERS[tierName];
  const types = Object.values(buckets).flat();

  const rows = await query({
    $select: "complaint_type, status, count(*) AS count",
    $where: [
      `within_circle(${LOCATION_FIELD}, ${lat}, ${lng}, ${radiusMeters})`,
      typeInClause(types),
      `created_date > ${soqlString(windowCutoffISO(now))}`,
    ].join(" AND "),
    $group: "complaint_type, status",
    $limit: String(SOCRATA_ROW_LIMIT),
  });

  // Zero-fill first: a bucket with no complaints returns no row at all, and a
  // missing bucket would otherwise become NaN downstream.
  const counts = Object.fromEntries(BUCKET_NAMES[tierName].map((b) => [b, 0]));
  const bucketStatusCounts = Object.fromEntries(
    BUCKET_NAMES[tierName].map((b) => [b, zeroStatusCounts()])
  );
  for (const row of rows) {
    const bucket = TYPE_TO_BUCKET[row.complaint_type];
    if (!bucket || !(bucket in counts)) continue;
    const n = Number(row.count);
    counts[bucket] += n;
    bucketStatusCounts[bucket][statusBucket(row.status)] += n;
  }
  return { counts, bucketStatusCounts };
}

/**
 * Both tiers for one point — the two HTTP calls per uncached address that
 * CLAUDE.md specifies (not six, not twelve). Issued in parallel.
 *
 * @returns {Promise<{building: object, block: object}>} each value is
 *   fetchCountsForTier's `{counts, bucketStatusCounts}` shape.
 */
export async function fetchAllCounts(lat, lng, options) {
  const [building, block] = await Promise.all([
    fetchCountsForTier(lat, lng, "building", options),
    fetchCountsForTier(lat, lng, "block", options),
  ]);
  return { building, block };
}

/**
 * Individual complaint points for the frontend heatmap. Unlike the count
 * queries this returns rows, so it is capped well below the row limit.
 */
/**
 * @param {object} [options]
 * @param {"building"|"block"} [options.tier] Restrict to one tier's complaint
 *   types. Omitted, the query spans every type in both tiers — which is right
 *   for a general "what's been filed near here" view, but wrong for a panel
 *   about one tier: within 25m of a Manhattan address the noise types alone
 *   exhaust the row limit, so the building types get crowded out of the result
 *   entirely and its history can't be charted.
 */
export async function fetchComplaints(lat, lng, radiusMeters, { now, limit = 1000, tier } = {}) {
  const tiers = tier ? [RADIUS_TIERS[tier]] : Object.values(RADIUS_TIERS);
  const types = tiers.flatMap(({ buckets }) => Object.values(buckets).flat());

  const rows = await query({
    $select: "unique_key, complaint_type, latitude, longitude, created_date, status",
    $where: [
      `within_circle(${LOCATION_FIELD}, ${lat}, ${lng}, ${radiusMeters})`,
      typeInClause(types),
      `created_date > ${soqlString(windowCutoffISO(now))}`,
    ].join(" AND "),
    $order: "created_date DESC",
    $limit: String(limit),
  });

  return rows.map((row) => ({
    // The dataset's own primary key — the number a renter could quote to 311.
    // Everything else about a row is descriptive; this is the only field that
    // identifies it, so it is the one thing worth surfacing verbatim.
    unique_key: row.unique_key ?? null,
    type: row.complaint_type,
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    created_date: row.created_date,
    status: row.status ?? null,
    // Mapped here rather than on the frontend so the eight-value status enum
    // has exactly one definition (constants.js). A second copy would be free
    // to drift — the frontend's old mapStatus() had already drifted, filing
    // "Assigned" and "Started" under open.
    statusBucket: statusBucket(row.status),
  }));
}

/**
 * Complaints grouped by (day, complaint_type, status) for one tier.
 *
 * This is the shape the complaints browser caches, and grouping upstream is
 * what makes the hardest locations tractable at all. 655 E 230 St in the Bronx
 * has 190,205 raw rows inside a 350m/24mo window — past SOCRATA_ROW_LIMIT, so
 * no raw-row cache could ever hold it — but only 1,848 grouped rows.
 *
 * Runs on COMPLAINT_FILL_TIMEOUT_MS, not the request-path budget: the
 * aggregation costs more upstream than the raw fetch it replaces, measured
 * 2.3-74.3s.
 *
 * @returns {Promise<Array<{day: string, type: string, statusBucket: string, count: number}>>}
 *   `day` is "YYYY-MM-DD", newest first.
 */
export async function fetchComplaintGroups(lat, lng, radiusMeters, { tier, months, now, limit } = {}) {
  const tiers = tier ? [RADIUS_TIERS[tier]] : Object.values(RADIUS_TIERS);
  const types = tiers.flatMap(({ buckets }) => Object.values(buckets).flat());

  const rows = await query(
    {
      $select: "date_trunc_ymd(created_date) AS day, complaint_type, status, count(*) AS cnt",
      $where: [
        `within_circle(${LOCATION_FIELD}, ${lat}, ${lng}, ${radiusMeters})`,
        typeInClause(types),
        `created_date > ${soqlString(cutoffISO(months, now))}`,
      ].join(" AND "),
      $group: "day, complaint_type, status",
      $order: "day DESC",
      $limit: String(limit ?? SOCRATA_ROW_LIMIT),
    },
    { timeoutMs: COMPLAINT_FILL_TIMEOUT_MS, retries: COMPLAINT_FILL_RETRIES }
  );

  return rows.map((row) => ({
    // date_trunc_ymd returns a full timestamp pinned to midnight; only the
    // calendar date is meaningful.
    day: String(row.day).slice(0, 10),
    type: row.complaint_type,
    statusBucket: statusBucket(row.status),
    count: Number(row.cnt),
  }));
}

/**
 * The individual complaints behind ONE (day, type) group.
 *
 * Paginated rather than merely capped: the largest single group measured is
 * 4,978 rows (655 E 230 St, 2025-01-05, Noise - Residential), with the next
 * four all above 4,000. A bare cap would silently hide most of it.
 *
 * Left uncached on purpose — measured 5.6s for a 17-row day, so the cost here
 * is the spatial filter, not the rows, and a day+type cache would buy little
 * for the maintenance of another collection.
 *
 * `status` filters UPSTREAM, and must: it is what makes $offset/$limit address
 * the same set of rows the caller is paging through. Filtering the returned page
 * instead — which this did — silently dropped rows, because the page was drawn
 * from every status and only then narrowed, so a day with 100 complaints of
 * which 3 were open could return none of them.
 */
export async function fetchComplaintsForGroup(
  lat,
  lng,
  radiusMeters,
  { type, day, status, offset = 0, limit = 50 } = {}
) {
  const where = [
    `within_circle(${LOCATION_FIELD}, ${lat}, ${lng}, ${radiusMeters})`,
    `complaint_type = ${soqlString(type)}`,
    `created_date >= ${soqlString(`${day}T00:00:00`)}`,
    `created_date < ${soqlString(`${day}T23:59:59.999`)}`,
  ];
  if (status) where.push(statusClause(status));

  const rows = await query({
    $select: "unique_key, complaint_type, latitude, longitude, created_date, status",
    $where: where.join(" AND "),
    $order: "created_date DESC",
    $offset: String(offset),
    $limit: String(limit),
  });

  return rows.map((row) => ({
    unique_key: row.unique_key ?? null,
    type: row.complaint_type,
    lat: Number(row.latitude),
    lng: Number(row.longitude),
    created_date: row.created_date,
    status: row.status ?? null,
    statusBucket: statusBucket(row.status),
  }));
}

/**
 * Complaints per calendar month for one tier, oldest first.
 *
 * Socrata does the bucketing via date_trunc_ym + $group, which is the whole
 * point: the response is one row per month — at most 25 — no matter how busy
 * the location is. The row-listing path (fetchComplaints) cannot answer this
 * question, because it returns the most recent N records and on a dense block
 * those N span days rather than months, so bucketing them client-side draws a
 * cliff instead of a history.
 *
 * Months with no complaints are absent from the response (there is no row to
 * group); callers zero-fill so the series is continuous.
 *
 * @returns {Promise<Array<{ month: string, count: number }>>} `month` is "YYYY-MM".
 */
export async function fetchMonthlyTrend(lat, lng, radiusMeters, { tier, months, now } = {}) {
  const tiers = tier ? [RADIUS_TIERS[tier]] : Object.values(RADIUS_TIERS);
  const types = tiers.flatMap(({ buckets }) => Object.values(buckets).flat());

  const rows = await query({
    $select: "date_trunc_ym(created_date) AS month, count(*) AS n",
    $where: [
      `within_circle(${LOCATION_FIELD}, ${lat}, ${lng}, ${radiusMeters})`,
      typeInClause(types),
      `created_date > ${soqlString(cutoffISO(months, now))}`,
    ].join(" AND "),
    $group: "month",
    $order: "month",
  });

  return rows.map((row) => ({
    // date_trunc_ym returns a full timestamp pinned to the 1st; only the
    // year-month is meaningful.
    month: String(row.month).slice(0, 7),
    count: Number(row.n),
  }));
}
