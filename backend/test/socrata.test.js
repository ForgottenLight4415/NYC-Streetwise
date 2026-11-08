import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchCountsForTier,
  fetchComplaints,
  fetchComplaintsForGroup,
  SocrataError,
} from "../src/providers/socrata.js";
import {
  LOCATION_FIELD,
  RADIUS_TIERS,
} from "../src/config/constants.js";

// No network. `fetch` is stubbed so we can assert on the SoQL we generate and
// on how the client behaves when Socrata misbehaves.

/** Builds a Response-alike; `rows` is what res.json() resolves to. */
function jsonResponse(rows, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => rows,
    text: async () => JSON.stringify(rows),
  };
}

function errorResponse(status, body = "boom") {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

let fetchMock;
const calls = () => fetchMock.mock.calls.map(([url]) => new URL(url));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("query construction", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse([]));
  });

  // The SoQL query filters with within_circle on the geo location field, not latitude/longitude.
  it("filters with within_circle on the geo column, not latitude/longitude", async () => {
    // Open item 2: `latitude` is a number and is rejected with a type mismatch.
    await fetchCountsForTier(40.7484, -73.9857, "building");
    const where = calls()[0].searchParams.get("$where");
    expect(where).toContain(
      `within_circle(${LOCATION_FIELD}, 40.7484, -73.9857, ${RADIUS_TIERS.building.radiusMeters})`
    );
    expect(where).not.toMatch(/within_circle\(latitude/);
  });

  // The SoQL query groups by complaint_type and status in one call with a large $limit.
  it("groups by complaint_type AND status so one HTTP call covers every bucket AND its status breakdown", async () => {
    await fetchCountsForTier(40.7484, -73.9857, "block");
    const params = calls()[0].searchParams;
    expect(params.get("$select")).toBe("complaint_type, status, count(*) AS count");
    expect(params.get("$group")).toBe("complaint_type, status");
    expect(Number(params.get("$limit"))).toBeGreaterThanOrEqual(50000);
  });

  // The SoQL query includes only the requested tier's complaint types.
  it("asks only for the tier's own complaint types", async () => {
    await fetchCountsForTier(40.7484, -73.9857, "building");
    const where = calls()[0].searchParams.get("$where");
    expect(where).toContain("'HEAT/HOT WATER'");
    // A block-tier type must not leak into the 25m query.
    expect(where).not.toContain("Illegal Parking");
  });

  // The SoQL type literals round-trip back to exactly the tier's complaint types, with quotes escaped.
  it("emits type literals that parse back to exactly the tier's types", async () => {
    // Round-tripping the `in (...)` list is the honest check on quoting: an
    // unescaped apostrophe in a future complaint_type would split one literal
    // into two and this comparison would fail.
    await fetchCountsForTier(40.7484, -73.9857, "block");
    const where = calls()[0].searchParams.get("$where");
    const list = where.match(/complaint_type in \((.*?)\)\) AND created_date/)[1];
    const parsed = list.split(",").map((literal) => {
      expect(literal).toMatch(/^'.*'$/);
      return literal.slice(1, -1).replace(/''/g, "'");
    });
    expect(parsed).toEqual(Object.values(RADIUS_TIERS.block.buckets).flat());
  });

  // The building query drops DOB Plumbing's permit descriptor while keeping rows with a NULL descriptor.
  it("drops DOB Plumbing's permit descriptor without dropping NULL descriptors", async () => {
    await fetchCountsForTier(40.7484, -73.9857, "building");
    const where = calls()[0].searchParams.get("$where");
    // The NULL-safe form: NOT (type AND descriptor in ...) would be NULL, and so
    // drop the row, whenever descriptor is NULL.
    expect(where).toContain(
      "(complaint_type != 'Plumbing' OR descriptor IS NULL OR " +
        "descriptor not in ('Plumbing Work - Illegal/No Permit/Standpipe/Sprinkler'))"
    );
  });

  // A tier with no excluded descriptors gets no descriptor clause in its query.
  it("adds no descriptor clause to a tier with no excluded descriptors", async () => {
    await fetchCountsForTier(40.7484, -73.9857, "block");
    expect(calls()[0].searchParams.get("$where")).not.toContain("descriptor");
  });

  // The SoQL query is limited to created_date after the trailing window cutoff.
  it("bounds the query to the trailing window", async () => {
    await fetchCountsForTier(40.7484, -73.9857, "block", {
      now: new Date("2026-08-15T00:00:00Z"),
    });
    expect(calls()[0].searchParams.get("$where")).toContain(
      "created_date > '2024-08-15T00:00:00'"
    );
  });

  // Socrata requests send the X-App-Token header when SOCRATA_APP_TOKEN is set.
  it("sends the app token when one is configured", async () => {
    vi.stubEnv("SOCRATA_APP_TOKEN", "tok-123");
    await fetchCountsForTier(40.7484, -73.9857, "block");
    expect(fetchMock.mock.calls[0][1].headers["X-App-Token"]).toBe("tok-123");
  });

  // The Socrata app token is read at call time, so it takes effect when set after import.
  it("reads the token at call time, so it can arrive after import", async () => {
    vi.stubEnv("SOCRATA_APP_TOKEN", "");
    await fetchCountsForTier(40.7484, -73.9857, "block");
    expect(fetchMock.mock.calls[0][1].headers["X-App-Token"]).toBeUndefined();

    vi.stubEnv("SOCRATA_APP_TOKEN", "arrived-later");
    await fetchCountsForTier(40.7484, -73.9857, "block");
    expect(fetchMock.mock.calls[1][1].headers["X-App-Token"]).toBe("arrived-later");
  });

  // Socrata requests carry an AbortSignal timeout.
  it("applies a timeout signal", async () => {
    await fetchCountsForTier(40.7484, -73.9857, "block");
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("bucket summing", () => {
  // fetchCountsForTier sums all complaint-type variants within a bucket into one count.
  it("sums every string variant of a bucket into ONE number", async () => {
    // The critical rule in CLAUDE.md: noise has 4 variants, plumbing has 3.
    // Percentiling per string and averaging would underweight noise.
    fetchMock.mockResolvedValue(
      jsonResponse([
        { complaint_type: "Noise - Residential", status: "Closed", count: "100" },
        { complaint_type: "Noise - Street/Sidewalk", status: "Closed", count: "50" },
        { complaint_type: "Noise - Vehicle", status: "Closed", count: "20" },
        { complaint_type: "Noise - Commercial", status: "Closed", count: "5" },
        { complaint_type: "Illegal Parking", status: "Closed", count: "7" },
        { complaint_type: "Blocked Driveway", status: "Closed", count: "3" },
        { complaint_type: "Street Condition", status: "Closed", count: "11" },
        { complaint_type: "Sidewalk Condition", status: "Closed", count: "4" },
        { complaint_type: "Abandoned Vehicle", status: "Closed", count: "6" },
        { complaint_type: "Rodent", status: "Closed", count: "2" },
      ])
    );

    const { counts } = await fetchCountsForTier(40.7, -73.9, "block");
    expect(counts).toEqual({
      noise: 175,
      parking: 16,
      streetCondition: 15,
      sanitation: 2,
      infrastructure: 0,
      publicSafety: 0,
    });
  });

  // fetchCountsForTier sums WATER LEAK into plumbing with PLUMBING, and splits statuses into open/closed.
  it("sums WATER LEAK into plumbing alongside PLUMBING", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { complaint_type: "PLUMBING", status: "Closed", count: "4" },
        { complaint_type: "WATER LEAK", status: "Open", count: "3" },
      ])
    );
    const { counts, bucketStatusCounts } = await fetchCountsForTier(40.7, -73.9, "building");
    expect(counts.plumbing).toBe(7);
    expect(bucketStatusCounts.plumbing).toEqual({ open: 3, "in-progress": 0, closed: 4 });
  });

  // fetchCountsForTier fills buckets Socrata omitted with 0, never NaN.
  it("zero-fills buckets Socrata omits entirely", async () => {
    // Socrata returns no row for an empty group; a missing key becomes NaN in
    // the scoring mean, which silently poisons the whole sub-score.
    fetchMock.mockResolvedValue(
      jsonResponse([{ complaint_type: "HEAT/HOT WATER", status: "Open", count: "42" }])
    );

    const { counts } = await fetchCountsForTier(40.7, -73.9, "building");
    expect(counts).toEqual({
      heatHotWater: 42,
      unsanitaryCondition: 0,
      plumbing: 0,
      repairs: 0,
      electricGas: 0,
      buildingSafety: 0,
    });
    for (const value of Object.values(counts)) {
      expect(Number.isNaN(value)).toBe(false);
    }
  });

  // fetchCountsForTier returns all-zero counts for an empty response.
  it("returns all-zero counts rather than {} for an empty response", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const { counts } = await fetchCountsForTier(40.7, -73.9, "building");
    expect(counts).toEqual({
      heatHotWater: 0,
      unsanitaryCondition: 0,
      plumbing: 0,
      repairs: 0,
      electricGas: 0,
      buildingSafety: 0,
    });
  });

  // fetchCountsForTier ignores complaint types outside the tier's buckets.
  it("ignores complaint types outside our buckets", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { complaint_type: "HEAT/HOT WATER", status: "Open", count: "5" },
        { complaint_type: "Non-Residential Heat", status: "Open", count: "999" },
      ])
    );
    const { counts } = await fetchCountsForTier(40.7, -73.9, "building");
    expect(counts.heatHotWater).toBe(5);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(5);
  });

  // fetchCountsForTier does not count block-tier types in a building-tier result.
  it("does not let a block-tier row land in a building-tier result", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ complaint_type: "Illegal Parking", status: "Open", count: "80" }])
    );
    const { counts } = await fetchCountsForTier(40.7, -73.9, "building");
    expect(counts).toEqual({
      heatHotWater: 0,
      unsanitaryCondition: 0,
      plumbing: 0,
      repairs: 0,
      electricGas: 0,
      buildingSafety: 0,
    });
  });
});

describe("bucketStatusCounts", () => {
  // fetchCountsForTier builds bucketStatusCounts by mapping raw statuses to open, in-progress or closed.
  it("buckets rows by statusBucket() and sums into the same bucket the count went to", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { complaint_type: "HEAT/HOT WATER", status: "Open", count: "3" },
        { complaint_type: "HEAT/HOT WATER", status: "Assigned", count: "2" },
        { complaint_type: "HEAT/HOT WATER", status: "Closed", count: "10" },
        { complaint_type: "PLUMBING", status: "Unspecified", count: "1" },
      ])
    );

    const { counts, bucketStatusCounts } = await fetchCountsForTier(40.7, -73.9, "building");
    expect(counts).toEqual({ heatHotWater: 15, unsanitaryCondition: 0, plumbing: 1, repairs: 0, electricGas: 0, buildingSafety: 0 });
    expect(bucketStatusCounts).toEqual({
      // "Assigned" sits with in-progress; "Unspecified" sits with open — see
      // STATUS_TO_BUCKET in constants.js.
      heatHotWater: { open: 3, "in-progress": 2, closed: 10 },
      unsanitaryCondition: { open: 0, "in-progress": 0, closed: 0 },
      plumbing: { open: 1, "in-progress": 0, closed: 0 },
      repairs: { open: 0, "in-progress": 0, closed: 0 },
      electricGas: { open: 0, "in-progress": 0, closed: 0 },
      buildingSafety: { open: 0, "in-progress": 0, closed: 0 },
    });
  });

  // fetchCountsForTier returns zeroed status counts for every bucket on an empty response.
  it("zero-fills every bucket's status breakdown, not just the buckets that had rows", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const { bucketStatusCounts } = await fetchCountsForTier(40.7, -73.9, "block");
    expect(bucketStatusCounts).toEqual({
      noise: { open: 0, "in-progress": 0, closed: 0 },
      parking: { open: 0, "in-progress": 0, closed: 0 },
      streetCondition: { open: 0, "in-progress": 0, closed: 0 },
      sanitation: { open: 0, "in-progress": 0, closed: 0 },
      infrastructure: { open: 0, "in-progress": 0, closed: 0 },
      publicSafety: { open: 0, "in-progress": 0, closed: 0 },
    });
  });

  // fetchCountsForTier's per-bucket status counts sum to that bucket's total count.
  it("each bucket's status triple sums back to that bucket's own count", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { complaint_type: "Illegal Parking", status: "Open", count: "4" },
        { complaint_type: "Blocked Driveway", status: "Pending", count: "6" },
        { complaint_type: "Illegal Parking", status: "Cancel", count: "2" },
      ])
    );
    const { counts, bucketStatusCounts } = await fetchCountsForTier(40.7, -73.9, "block");
    for (const bucket of Object.keys(counts)) {
      const total = Object.values(bucketStatusCounts[bucket]).reduce((a, b) => a + b, 0);
      expect(total).toBe(counts[bucket]);
    }
  });
});

describe("retry policy", () => {
  // fetchCountsForTier retries a 429 and succeeds on the next attempt.
  it("retries a 429 and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(
        jsonResponse([{ complaint_type: "PLUMBING", count: "2" }])
      );

    const { counts } = await fetchCountsForTier(40.7, -73.9, "building");
    expect(counts.plumbing).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // fetchCountsForTier retries a 5xx response.
  it("retries a 5xx", async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(jsonResponse([]));
    await fetchCountsForTier(40.7, -73.9, "building");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // fetchCountsForTier does not retry a 400 and throws SocrataError after one call.
  it("does NOT retry a 400 — malformed SoQL fails identically every time", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(400, "query.soql.type-mismatch")
    );
    await expect(fetchCountsForTier(40.7, -73.9, "building")).rejects.toThrow(
      SocrataError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // fetchCountsForTier throws a SocrataError carrying status and body on a non-retryable failure (403).
  it("surfaces the Socrata status and body on a non-retryable failure", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "forbidden"));
    await expect(
      fetchCountsForTier(40.7, -73.9, "building")
    ).rejects.toMatchObject({ name: "SocrataError", status: 403 });
  });

  // fetchCountsForTier retries network errors up to the configured attempts, then throws SocrataError.
  it("retries network errors and gives up after the configured attempts", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(fetchCountsForTier(40.7, -73.9, "building")).rejects.toThrow(
      SocrataError
    );
    // 1 initial + SOCRATA_MAX_RETRIES.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // fetchCountsForTier wraps the final network error as a SocrataError with the original as its cause.
  it("wraps the last error as a SocrataError with a cause", async () => {
    const network = new Error("ETIMEDOUT");
    fetchMock.mockRejectedValue(network);
    await expect(
      fetchCountsForTier(40.7, -73.9, "building")
    ).rejects.toMatchObject({ name: "SocrataError", cause: network });
  });
});

describe("fetchComplaints", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          unique_key: "70072819",
          complaint_type: "Noise - Residential",
          latitude: "40.7484",
          longitude: "-73.9857",
          created_date: "2026-01-02T03:04:05.000",
          status: "Closed",
        },
        {
          complaint_type: "HEAT/HOT WATER",
          latitude: "40.7485",
          longitude: "-73.9858",
          created_date: "2026-01-01T00:00:00.000",
        },
      ])
    );
  });

  // fetchComplaints maps rows into the contract shape with numeric lat/lng, type, status and statusBucket.
  it("maps rows into the heatmap contract shape with numeric coords", async () => {
    const points = await fetchComplaints(40.7484, -73.9857, 350);
    expect(points[0]).toEqual({
      unique_key: "70072819",
      type: "Noise - Residential",
      lat: 40.7484,
      lng: -73.9857,
      created_date: "2026-01-02T03:04:05.000",
      status: "Closed",
      statusBucket: "closed",
    });
  });

  // The only field that identifies a row, and the number a renter can quote to
  // 311 — so it has to be asked for explicitly, not inferred.
  // fetchComplaints selects unique_key.
  it("selects unique_key, the dataset's own primary key", async () => {
    await fetchComplaints(40.7484, -73.9857, 350);
    expect(calls()[0].searchParams.get("$select")).toContain("unique_key");
  });

  // fetchComplaints sets unique_key to null when a row lacks it.
  it("nulls a missing unique_key rather than dropping the key", async () => {
    const points = await fetchComplaints(40.7484, -73.9857, 350);
    expect(points[1].unique_key).toBeNull();
  });

  // fetchComplaints sets status to null when a row lacks it.
  it("nulls a missing status rather than dropping the key", async () => {
    const points = await fetchComplaints(40.7484, -73.9857, 350);
    expect(points[1].status).toBeNull();
  });

  // The raw status stays on the row, but every consumer reads statusBucket:
  // the dataset returns eight distinct values, and mapping them in one place
  // is what stops "Assigned" being filed under open again.
  // fetchComplaints buckets an unrecognised status as open.
  it("buckets an unknown status as open rather than dropping it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          complaint_type: "Noise - Residential",
          latitude: "40.7484",
          longitude: "-73.9857",
          created_date: "2026-01-02T03:04:05.000",
          status: "Some Future Status",
        },
      ])
    );
    const points = await fetchComplaints(40.7484, -73.9857, 350);
    expect(points[0].statusBucket).toBe("open");
  });

  // fetchComplaints buckets Assigned and Started as in-progress.
  it("buckets Assigned and Started as in-progress, not open", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { complaint_type: "PLUMBING", latitude: "40.7", longitude: "-73.9", created_date: "2026-01-02T00:00:00.000", status: "Assigned" },
        { complaint_type: "PLUMBING", latitude: "40.7", longitude: "-73.9", created_date: "2026-01-01T00:00:00.000", status: "Started" },
      ])
    );
    const points = await fetchComplaints(40.7484, -73.9857, 350);
    expect(points.map((p) => p.statusBucket)).toEqual(["in-progress", "in-progress"]);
  });

  // fetchComplaints requests ungrouped rows, newest first, with the given limit.
  it("requests rows (not counts), newest first, under a row cap", async () => {
    await fetchComplaints(40.7484, -73.9857, 350, { limit: 250 });
    const params = calls()[0].searchParams;
    expect(params.get("$group")).toBeNull();
    expect(params.get("$order")).toBe("created_date DESC");
    expect(params.get("$limit")).toBe("250");
  });

  // fetchComplaints queries complaint types from both tiers within the given circle.
  it("includes types from both tiers, since the heatmap shows everything", async () => {
    await fetchComplaints(40.7484, -73.9857, 350);
    const where = calls()[0].searchParams.get("$where");
    expect(where).toContain("'HEAT/HOT WATER'");
    expect(where).toContain("'Illegal Parking'");
    expect(where).toContain("within_circle(location, 40.7484, -73.9857, 350)");
  });
});

describe("fetchComplaintsForGroup", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse([]));
  });

  const whereFor = async (opts) => {
    await fetchComplaintsForGroup(40.7484, -73.9857, 350, {
      type: "Noise - Residential",
      day: "2026-08-14",
      ...opts,
    });
    return calls()[0].searchParams.get("$where");
  };

  // fetchComplaintsForGroup selects unique_key so drill-ins can show the 311 case number.
  it("selects unique_key so a drill-in can show the real 311 case number", async () => {
    const where = await whereFor({});
    expect(where).toBeTruthy();
    expect(calls()[0].searchParams.get("$select")).toContain("unique_key");
  });

  // fetchComplaintsForGroup restricts the query to the group's type and its single day.
  it("bounds the query to the one day and type the group describes", async () => {
    const where = await whereFor({});
    expect(where).toContain("(complaint_type in ('Noise - Residential'))");
    expect(where).toContain("created_date >= '2026-08-14T00:00:00'");
    expect(where).toContain("created_date < '2026-08-14T23:59:59.999'");
  });

  // fetchComplaintsForGroup applies the same descriptor exclusion as the grouped counts (Plumbing only).
  it("applies the same descriptor exclusion the grouped counts did", async () => {
    // Otherwise a day's drill-down would list permit complaints its group count
    // left out.
    expect(await whereFor({ type: "Plumbing" })).toContain("descriptor not in (");
    fetchMock.mockClear();
    expect(await whereFor({ type: "PLUMBING" })).not.toContain("descriptor");
  });

  // fetchComplaintsForGroup adds no status predicate when no status filter is given.
  it("adds no status predicate when the caller did not filter", async () => {
    const where = await whereFor({});
    expect(where).not.toContain("status");
  });

  // Paging is $offset/$limit over the filtered set, so the filter has to be
  // upstream. Filtering the returned page instead dropped rows silently.
  // fetchComplaintsForGroup filters the closed status upstream as Closed and Cancel.
  it("filters closed upstream as a plain in-list", async () => {
    const where = await whereFor({ status: "closed" });
    expect(where).toContain("status in ('Closed','Cancel')");
  });

  // fetchComplaintsForGroup filters in-progress upstream, including In Progress, Pending, Assigned and Started.
  it("filters in-progress upstream, including Assigned/Started/Pending", async () => {
    const where = await whereFor({ status: "in-progress" });
    expect(where).toContain("'In Progress'");
    expect(where).toContain("'Pending'");
    expect(where).toContain("'Assigned'");
    expect(where).toContain("'Started'");
  });

  // statusBucket() sends NULL and anything unrecognised to open, so the query
  // has to match the complement too — otherwise a filtered page would omit rows
  // the grouped counts had already counted, which is the exact disagreement
  // this endpoint was fixed for.
  // fetchComplaintsForGroup matches the open filter as a complement, including NULL and unrecognised statuses.
  it("matches open as a total complement, not just the known open strings", async () => {
    const where = await whereFor({ status: "open" });
    expect(where).toContain("status in ('Open','Unspecified')");
    expect(where).toContain("status IS NULL");
    expect(where).toMatch(/status not in \([^)]*'Closed'[^)]*\)/);
    expect(where).toMatch(/status not in \([^)]*'Assigned'[^)]*\)/);
  });
});
