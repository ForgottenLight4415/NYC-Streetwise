import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestServer } from "./helpers/testServer.js";
import { resetRateLimits } from "../src/lib/rateLimit.js";
import {
  RADIUS_TIERS,
  BUCKET_NAMES,
  AMENITY_TIERS,
  AMENITY_BUCKET_NAMES,
  COMPLAINTS_DEFAULT_LIMIT,
  COMPLAINT_GROUPS_CACHE_LIMIT,
  CONFIDENCE,
  CONFIDENCE_REASONS,
} from "../src/config/constants.js";

// End-to-end over real HTTP against the frozen API contract in CLAUDE.md.
// If a test in this file has to change, the contract changed — which needs
// team sign-off, not a quiet edit.
//
// Socrata is FAKED, everything else is real: the routes, the scorer, and the
// committed baseline (no MONGODB_URI here, so the file fallback is what loads).
// That is deliberate — this file's job is to prove the wiring produces the
// contract shape from real code, not to re-test the client.

const { countsSpy, complaintsSpy, groupsSpy, groupDetailSpy, aiSpy } = vi.hoisted(() => ({
  countsSpy: vi.fn(),
  complaintsSpy: vi.fn(),
  groupsSpy: vi.fn(),
  groupDetailSpy: vi.fn(),
  aiSpy: vi.fn(),
}));

vi.mock("../src/providers/socrata.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchCountsForTier: countsSpy,
    fetchComplaints: complaintsSpy,
    fetchComplaintGroups: groupsSpy,
    fetchComplaintsForGroup: groupDetailSpy,
  };
});

// The AI adapter is mocked too. Without this the explanation route reaches a
// real Ollama server whenever the developer happens to have one running — the
// suite would pass or fail depending on the machine, and would be making
// network calls the rest of the suite is careful to avoid.
vi.mock("../src/providers/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, generateExplanation: aiSpy };
});

// Defaults to the REAL implementation (importOriginal) — amenity data is
// local, committed JSON, so most tests exercise it for real. Only the
// degradation test below overrides it, to simulate every amenity dataset
// failing to load without touching the committed files.
const { loadAmenitiesSpy, actualLoadAmenities } = vi.hoisted(() => ({
  loadAmenitiesSpy: vi.fn(),
  actualLoadAmenities: {},
}));

vi.mock("../src/providers/amenities/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  actualLoadAmenities.fn = actual.loadAmenities;
  return { ...actual, loadAmenities: loadAmenitiesSpy };
});

const { SocrataError } = await import("../src/providers/socrata.js");

const COUNTS = {
  building: { heatHotWater: 12, unsanitaryCondition: 3, plumbing: 1, repairs: 0, electricGas: 0, buildingSafety: 0 },
  block: { noise: 1653, parking: 402, streetCondition: 88, sanitation: 0, infrastructure: 0, publicSafety: 0 },
};

function complaintRow(index) {
  return {
    type: "Noise - Residential",
    lat: 40.7484 + index * 1e-5,
    lng: -73.9857,
    created_date: "2026-01-01T00:00:00.000",
    status: "Closed",
    statusBucket: "closed",
  };
}

/** One (day, type, status) tuple as fetchComplaintGroups returns it. */
function groupTuple(day, type, statusBucket, count) {
  return { day, type, statusBucket, count };
}

/** "YYYY-MM-DD" (UTC, matching the route's own cutoff maths) for `n` days before today. */
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Fixture days for the grouped browser are relative to today, not fixed dates:
// the route drops groups older than the default 24-month window, so a fixed
// date silently ages out and breaks the totals. RECENT_DAY is inside every
// offered window (including 3 months); OLD_DAY is inside 24 months but outside 3.
const RECENT_DAY = daysAgo(14);
const OLD_DAY = daysAgo(365);

let server;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  // Per-process limits, one host, hundreds of requests: cleared so a limiter
  // is never the reason a contract assertion fails.
  resetRateLimits();
  countsSpy.mockReset();
  complaintsSpy.mockReset();
  aiSpy.mockReset();
  aiSpy.mockResolvedValue("A generated sentence about this location.");
  countsSpy.mockImplementation(async (lat, lng, tier) => ({ counts: COUNTS[tier] }));
  complaintsSpy.mockImplementation(async (lat, lng, radius, { limit }) =>
    Array.from({ length: Math.min(25, limit) }, (_, i) => complaintRow(i))
  );
  loadAmenitiesSpy.mockReset();
  loadAmenitiesSpy.mockImplementation(actualLoadAmenities.fn);
});

describe("GET /health", () => {
  // GET /health returns 200 with status ok and a numeric uptimeSeconds.
  it("answers 200 for deploy checks and keep-warm pings", async () => {
    const { status, body } = await server.request("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.uptimeSeconds).toBeTypeOf("number");
  });

  // GET /health sends Cache-Control: no-store.
  it("is never cached — a cached 200 would mask a wedged instance", async () => {
    const { headers } = await server.request("/health");
    expect(headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /api/score", () => {
  // POST /api/score returns the report shape: null address, both tiers' radii and bucket keys, scores 0-100 and a good/fair/poor band.
  it("returns the frozen report shape", async () => {
    const { status, body } = await server.request("/api/score", {
      method: "POST",
      body: { lat: 40.7484, lng: -73.9857 },
    });

    expect(status).toBe(200);
    expect(body.address).toBeNull();

    expect(body.buildingHealth.radiusMeters).toBe(
      RADIUS_TIERS.building.radiusMeters
    );
    expect(Object.keys(body.buildingHealth.counts).sort()).toEqual(
      [...BUCKET_NAMES.building].sort()
    );
    expect(body.blockQuality.radiusMeters).toBe(RADIUS_TIERS.block.radiusMeters);
    expect(Object.keys(body.blockQuality.counts).sort()).toEqual(
      [...BUCKET_NAMES.block].sort()
    );

    for (const sub of [body.buildingHealth, body.blockQuality]) {
      expect(sub.score).toBeGreaterThanOrEqual(0);
      expect(sub.score).toBeLessThanOrEqual(100);
      expect(["good", "fair", "poor"]).toContain(sub.band);
    }
  });

  // POST /api/score passes Socrata's per-bucket counts through and scores each bucket (zero count = 100, busiest bucket lower).
  it("passes the provider's per-bucket counts through and scores each one", async () => {
    const { body } = await server.request("/api/score", {
      method: "POST",
      body: { lat: 40.7484, lng: -73.9857 },
    });
    expect(body.buildingHealth.counts).toEqual(COUNTS.building);
    expect(body.blockQuality.counts).toEqual(COUNTS.block);
    // Scored per bucket, not just echoed: a zero-count bucket is a perfect 100,
    // and the busiest bucket (noise, 1653) scores below it.
    expect(body.blockQuality.bucketScores.sanitation).toBe(100);
    expect(body.blockQuality.bucketScores.noise).toBeLessThan(
      body.blockQuality.bucketScores.sanitation
    );
  });

  // POST /api/score includes the additive fields: confidence, bucketScores matching counts, bucketConfidence (streetCondition weak) and baselineVersion.
  it("carries the agreed additive fields", async () => {
    // Additive extensions agreed in handoff.md — a frontend that ignores them
    // keeps working, but they must be present for one that does not.
    const { body } = await server.request("/api/score", {
      method: "POST",
      body: { lat: 40.7484, lng: -73.9857 },
    });

    for (const sub of [body.buildingHealth, body.blockQuality]) {
      expect([CONFIDENCE.normal, CONFIDENCE.low]).toContain(sub.confidence);
      expect(Object.keys(sub.bucketScores).sort()).toEqual(
        Object.keys(sub.counts).sort()
      );
    }
    // streetCondition is the one bucket flagged weak; building has none.
    expect(body.blockQuality.bucketConfidence).toEqual({
      streetCondition: CONFIDENCE.low,
    });
    expect(body.buildingHealth.bucketConfidence).toEqual({});
    expect(body.meta.baselineVersion).toBeTypeOf("string");
  });

  // POST /api/score gives an all-zero building a score of 100 but flags it low confidence with noComplaintsFound, leaving the block normal.
  it("flags a building with no complaints as low confidence", async () => {
    // The score is honest to the data (100), the doubt rides alongside it.
    countsSpy.mockImplementation(async (lat, lng, tier) => ({
      counts:
        tier === "building"
          ? { heatHotWater: 0, unsanitaryCondition: 0, plumbing: 0, repairs: 0, electricGas: 0, buildingSafety: 0 }
          : COUNTS.block,
    }));

    const { body } = await server.request("/api/score", {
      method: "POST",
      body: { lat: 40.7484, lng: -73.9857 },
    });
    expect(body.buildingHealth.score).toBe(100);
    expect(body.buildingHealth.confidence).toBe(CONFIDENCE.low);
    expect(body.buildingHealth.confidenceReason).toBe(
      CONFIDENCE_REASONS.noComplaintsFound
    );
    expect(body.blockQuality.confidence).toBe(CONFIDENCE.normal);
  });

  // POST /api/score returns 503 upstream_unavailable, not 500, when Socrata is down.
  it("503s rather than 500s when the upstream is down", async () => {
    // Socrata went fully dark for hours during M3. The frontend can say "NYC's
    // data service is unavailable" off a 503; it can say nothing off a 500.
    countsSpy.mockRejectedValue(new SocrataError("socrata 503: down", { status: 503 }));

    const { status, body } = await server.request("/api/score", {
      method: "POST",
      body: { lat: 40.7484, lng: -73.9857 },
    });
    expect(status).toBe(503);
    expect(body.error).toBe("upstream_unavailable");
  });

  // POST /api/score returns 400 with an error and details for a missing body, missing lng, non-numeric lat, out-of-NYC coordinates and swapped lat/lng.
  it.each([
    ["missing body", {}],
    ["missing lng", { lat: 40.7484 }],
    ["non-numeric lat", { lat: "somewhere", lng: -73.9857 }],
    ["outside NYC", { lat: 34.05, lng: -118.24 }],
    ["swapped lat/lng", { lat: -73.9857, lng: 40.7484 }],
  ])("400s on %s", async (_label, payload) => {
    const { status, body } = await server.request("/api/score", {
      method: "POST",
      body: payload,
    });
    expect(status).toBe(400);
    expect(body.error).toBeTypeOf("string");
    expect(body.details).toBeTypeOf("string");
  });

  // POST /api/score returns 400 rather than 500 when no request body is sent.
  it("400s rather than 500s when no body is sent at all", async () => {
    const res = await fetch(`${server.baseUrl}/api/score`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  // POST /api/score rejects invalid coordinates without calling Socrata.
  it("rejects bad input before spending an upstream call", async () => {
    await server.request("/api/score", {
      method: "POST",
      body: { lat: 34.05, lng: -118.24 },
    });
    expect(countsSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/score — amenity sections", () => {
  // 123 Ludlow St — dense LES, real committed amenity data (no Socrata
  // dependency) finds something in every bucket. Walkability has no
  // committed dataset — it is a live Google Places lookup — and this test
  // environment has no GOOGLE_MAPS_API_KEY, so it degrades to "nothing
  // found" (searchNearbyPlaces returns [] without a network call) rather
  // than finding real nearby amenities. That degrade is itself the thing
  // worth asserting: the section must still be present, scored, and banded,
  // not silently omitted just because the live call didn't fire.
  const LUDLOW_ST = { lat: 40.7215, lng: -73.9878 };

  // POST /api/score for a dense address returns all six scored sections plus summary and meta, each amenity section with its radius, metrics, score and band, and walkability empty without an API key.
  it("returns the full six-section payload", async () => {
    const { status, body } = await server.request("/api/score", {
      method: "POST",
      body: LUDLOW_ST,
    });

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      [
        "address",
        "bikeAccess",
        "blockQuality",
        "buildingHealth",
        "meta",
        "parksAccess",
        "summary",
        "transitAccess",
        "walkabilityAccess",
      ].sort()
    );

    for (const [tier, reportKey] of [
      ["transit", "transitAccess"],
      ["parks", "parksAccess"],
      ["bike", "bikeAccess"],
      ["walkability", "walkabilityAccess"],
    ]) {
      const section = body[reportKey];
      expect(section.radiusMeters).toBe(AMENITY_TIERS[tier].radiusMeters);
      expect(Object.keys(section.metrics).sort()).toEqual([...AMENITY_BUCKET_NAMES[tier]].sort());
      expect(section.score).toBeGreaterThanOrEqual(0);
      expect(section.score).toBeLessThanOrEqual(100);
      expect(["excellent", "typical", "carDependent"]).toContain(section.band);
    }

    // No API key in this environment: every walkability bucket degrades to
    // "nothing found" rather than a real distance.
    for (const metric of Object.values(body.walkabilityAccess.metrics)) {
      expect(metric.meters).toBeNull();
      expect(metric.within).toBe(0);
    }
  });

  // POST /api/score still returns the complaint sections plus walkability when all three static amenity datasets fail to load.
  it("degrades to the two complaint sections plus walkability when every static dataset fails to load", async () => {
    loadAmenitiesSpy.mockResolvedValue({ transit: null, parks: null, bike: null });

    const { status, body } = await server.request("/api/score", {
      method: "POST",
      body: LUDLOW_ST,
    });

    expect(status).toBe(200);
    // Walkability survives this failure because it does not depend on
    // loadAmenities() at all — it is a wholly separate, live-Places code
    // path. A failure of the three STATIC datasets is not a fact about
    // whether Google Places is reachable.
    expect(Object.keys(body).sort()).toEqual(
      ["address", "blockQuality", "buildingHealth", "meta", "summary", "walkabilityAccess"].sort()
    );
    // The complaint side must be completely unaffected by the amenity failure.
    expect(body.buildingHealth.score).toBeGreaterThanOrEqual(0);
  });

  // POST /api/score omits only the amenity tier that failed to load and keeps the others.
  it("omits only the failing tier, not the other two, on a partial amenity failure", async () => {
    loadAmenitiesSpy.mockImplementation(async () => {
      const real = await actualLoadAmenities.fn();
      return { ...real, transit: null };
    });

    const { body } = await server.request("/api/score", { method: "POST", body: LUDLOW_ST });
    expect(body).not.toHaveProperty("transitAccess");
    expect(body).toHaveProperty("parksAccess");
    expect(body).toHaveProperty("bikeAccess");
  });
});

describe("GET /api/complaints", () => {
  // GET /api/complaints returns an array of points with exactly the contract keys.
  it("returns an array of points in the contract shape", async () => {
    const { status, body } = await server.request(
      "/api/complaints?lat=40.7484&lng=-73.9857&radius=350"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(Object.keys(body[0]).sort()).toEqual([
      "created_date",
      "lat",
      "lng",
      "status",
      "statusBucket",
      "type",
    ]);
  });

  // GET /api/complaints passes the requested tier through to Socrata.
  it("passes the tier through so a panel only sees its own complaint types", async () => {
    await server.request("/api/complaints?lat=40.7484&lng=-73.9857&radius=25&tier=building");
    expect(complaintsSpy).toHaveBeenCalledWith(
      40.7484,
      -73.9857,
      25,
      expect.objectContaining({ tier: "building" })
    );
  });

  // GET /api/complaints never runs the grouped fill unless complete=1.
  it("never triggers the grouped fill without complete=1", async () => {
    // The fill was measured at 2.3-74.3s. Report load must not pay for it.
    await server.request("/api/complaints?lat=40.7484&lng=-73.9857&tier=block");
    expect(groupsSpy).not.toHaveBeenCalled();
  });

  // GET /api/complaints defaults to the block radius and default row limit when none are given.
  it("defaults to the block radius when none is given", async () => {
    await server.request("/api/complaints?lat=40.7484&lng=-73.9857");
    expect(complaintsSpy).toHaveBeenCalledWith(
      40.7484,
      -73.9857,
      RADIUS_TIERS.block.radiusMeters,
      expect.objectContaining({ limit: COMPLAINTS_DEFAULT_LIMIT })
    );
  });

  // GET /api/complaints sets x-complaints-truncated and x-complaints-limit headers when the row cap is hit.
  it("reports truncation in headers when the row cap is hit", async () => {
    // A dense block returns only its most recent months at the cap. The array
    // shape is frozen, so the warning rides in a header instead — a frontend
    // that counts from this endpoint would disagree with the score.
    complaintsSpy.mockImplementation(async (lat, lng, radius, { limit }) =>
      Array.from({ length: limit }, (_, i) => complaintRow(i))
    );

    const { headers, body } = await server.request(
      "/api/complaints?lat=40.6944&lng=-73.9213&limit=50"
    );
    expect(body).toHaveLength(50);
    expect(headers.get("x-complaints-truncated")).toBe("true");
    expect(headers.get("x-complaints-limit")).toBe("50");
  });

  // GET /api/complaints sets x-complaints-truncated to false when the result is complete.
  it("says so when the result is complete", async () => {
    const { headers } = await server.request(
      "/api/complaints?lat=40.7484&lng=-73.9857"
    );
    expect(headers.get("x-complaints-truncated")).toBe("false");
  });

  // GET /api/complaints exposes the truncation headers through Access-Control-Expose-Headers.
  it("exposes the truncation headers to cross-origin JS", async () => {
    // Without Access-Control-Expose-Headers the browser receives these headers
    // and refuses to let the frontend read them.
    const { headers } = await server.request(
      "/api/complaints?lat=40.7484&lng=-73.9857"
    );
    const exposed = headers.get("access-control-expose-headers") ?? "";
    expect(exposed.toLowerCase()).toContain("x-complaints-truncated");
  });

  // GET /api/complaints returns 400 for missing coordinates, out-of-bounds coordinates, zero or oversized radius, and oversized or fractional limit.
  it.each([
    ["missing coords", "/api/complaints"],
    ["out of bounds", "/api/complaints?lat=34.05&lng=-118.24"],
    ["zero radius", "/api/complaints?lat=40.7484&lng=-73.9857&radius=0"],
    ["oversized radius", "/api/complaints?lat=40.7484&lng=-73.9857&radius=99999"],
    ["oversized limit", "/api/complaints?lat=40.7484&lng=-73.9857&limit=999999"],
    ["fractional limit", "/api/complaints?lat=40.7484&lng=-73.9857&limit=1.5"],
  ])("400s on %s", async (_label, path) => {
    const { status, body } = await server.request(path);
    expect(status).toBe(400);
    expect(body.error).toBeTypeOf("string");
  });
});

describe("GET /api/complaints?complete=1 (grouped browser)", () => {
  const BASE = "/api/complaints?lat=40.7484&lng=-73.9857&radius=350&tier=block&complete=1";

  beforeEach(() => {
    // Two types on one day plus an older day, with a status split inside the
    // first, so collapsing and status filtering are both observable.
    groupsSpy.mockResolvedValue([
      groupTuple(RECENT_DAY, "Noise - Residential", "closed", 7),
      groupTuple(RECENT_DAY, "Noise - Residential", "open", 3),
      groupTuple(RECENT_DAY, "Illegal Parking", "closed", 2),
      groupTuple(OLD_DAY, "Street Condition", "open", 5),
    ]);
  });

  // GET /api/complaints?complete=1 returns one row per (day, type) with a per-status breakdown and total.
  it("returns one row per (day, type) with a status breakdown inside", async () => {
    const { status, body } = await server.request(BASE);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toEqual({
      day: RECENT_DAY,
      type: "Illegal Parking",
      counts: { open: 0, "in-progress": 0, closed: 2 },
      total: 2,
    });
    const noise = body.find((r) => r.type === "Noise - Residential");
    expect(noise.counts).toEqual({ open: 3, "in-progress": 0, closed: 7 });
    expect(noise.total).toBe(10);
  });

  // GET /api/complaints?complete=1 reports the number of groups, not complaints, in x-complaints-total.
  it("counts GROUPS in the total, not the complaints inside them", async () => {
    // 3 distinct (day, type) pairs covering 17 underlying complaints.
    const { headers } = await server.request(BASE);
    expect(headers.get("x-complaints-total")).toBe("3");
  });

  // GET /api/complaints?complete=1 fills the group cache at COMPLAINT_GROUPS_CACHE_LIMIT regardless of the caller's page size.
  it("fills at the cache limit, never at the caller's page size", async () => {
    await server.request(`${BASE}&limit=25`);
    expect(groupsSpy).toHaveBeenCalledWith(
      40.7484,
      -73.9857,
      350,
      expect.objectContaining({ limit: COMPLAINT_GROUPS_CACHE_LIMIT })
    );
  });

  // GET /api/complaints?complete=1 restricts results to the requested months window and adjusts the total.
  it("narrows to the requested window", async () => {
    const { body, headers } = await server.request(`${BASE}&months=3`);
    expect(body.every((r) => r.day === RECENT_DAY)).toBe(true);
    expect(headers.get("x-complaints-total")).toBe("2");
  });

  // GET /api/complaints?complete=1 allows ten cold fills per minute, then returns 429 rate_limited with Retry-After and no further Socrata call.
  it("still limits cold fills: the eleventh in a minute is refused with 429", async () => {
    // No Mongo in this file, so every grouped request is a real fill. Cached
    // pages are exempt; see scoreService.test.js's beforeFill tests.
    const fillsBefore = groupsSpy.mock.calls.length;
    for (let i = 0; i < 10; i++) {
      expect((await server.request(BASE)).status).toBe(200);
    }
    const refused = await server.request(BASE);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe("rate_limited");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // The refused request never reached Socrata.
    expect(groupsSpy.mock.calls.length - fillsBefore).toBe(10);
  });

  // GET /api/complaints?complete=1 filters groups by complaint bucket.
  it("filters by complaint bucket", async () => {
    const { body } = await server.request(`${BASE}&bucket=parking`);
    expect(body).toHaveLength(1);
    expect(body[0].type).toBe("Illegal Parking");
  });

  // GET /api/complaints?complete=1 filters by status and drops groups left with no matching complaints.
  it("filters by status and drops groups left with nothing", async () => {
    const { body } = await server.request(`${BASE}&status=open`);
    // Illegal Parking was closed-only, so its group disappears entirely rather
    // than surfacing as a zero row.
    expect(body.map((r) => r.type).sort()).toEqual(["Noise - Residential", "Street Condition"]);
    expect(body.find((r) => r.type === "Noise - Residential").total).toBe(3);
  });

  // GET /api/complaints?complete=1 per-status totals add up to the unfiltered total.
  it("splits the unfiltered total across the three status buckets with nothing lost", async () => {
    const unfiltered = await server.request(BASE);
    const sum = (rows) => rows.reduce((n, r) => n + r.total, 0);
    const parts = await Promise.all(
      ["open", "in-progress", "closed"].map((s) => server.request(`${BASE}&status=${s}`))
    );
    expect(parts.reduce((n, p) => n + sum(p.body), 0)).toBe(sum(unfiltered.body));
  });

  // GET /api/complaints?complete=1 pages over groups with limit and offset, giving disjoint pages and correct has-more and offset headers.
  it("pages over groups with a stable, disjoint order", async () => {
    const first = await server.request(`${BASE}&limit=2&offset=0`);
    const second = await server.request(`${BASE}&limit=2&offset=2`);
    expect(first.body).toHaveLength(2);
    expect(second.body).toHaveLength(1);
    expect(first.headers.get("x-complaints-has-more")).toBe("true");
    expect(second.headers.get("x-complaints-has-more")).toBe("false");
    expect(second.headers.get("x-complaints-offset")).toBe("2");
    const keys = (rows) => rows.map((r) => `${r.day}|${r.type}`);
    expect(keys(first.body).filter((k) => keys(second.body).includes(k))).toEqual([]);
  });

  // GET /api/complaints?complete=1 sets x-complaints-truncated when the group fill reaches the cache limit.
  it("reports truncation when the grouped fill hits the cache limit", async () => {
    groupsSpy.mockResolvedValue(
      Array.from({ length: COMPLAINT_GROUPS_CACHE_LIMIT }, (_, i) =>
        groupTuple(RECENT_DAY, `Type ${i}`, "closed", 1)
      )
    );
    const { headers } = await server.request(BASE);
    expect(headers.get("x-complaints-truncated")).toBe("true");
  });

  // GET /api/complaints?complete=1 returns 400 for a negative or oversized offset, unknown bucket, raw status or unsupported months window.
  it.each([
    ["negative offset", `${BASE}&offset=-1`],
    ["oversized offset", `${BASE}&offset=999999`],
    ["unknown bucket", `${BASE}&bucket=nope`],
    ["raw status instead of a bucket", `${BASE}&status=Pending`],
    ["window outside the offered set", `${BASE}&months=7`],
  ])("400s on %s", async (_label, path) => {
    const { status, body } = await server.request(path);
    expect(status).toBe(400);
    expect(body.error).toBeTypeOf("string");
  });

  // GET /api/complaints?complete=1 returns 400 missing_tier when a bucket is given without a tier.
  it("400s when a bucket is given without a tier to scope it", async () => {
    const { status, body } = await server.request(
      "/api/complaints?lat=40.7484&lng=-73.9857&complete=1&bucket=noise"
    );
    expect(status).toBe(400);
    expect(body.error).toBe("missing_tier");
  });
});

describe("GET /api/complaints/group (drill-in)", () => {
  const BASE =
    "/api/complaints/group?lat=40.7484&lng=-73.9857&tier=block&type=Noise%20-%20Residential&day=2026-08-14";

  beforeEach(() => {
    groupDetailSpy.mockImplementation(async (lat, lng, radius, { limit }) =>
      Array.from({ length: limit }, (_, i) => complaintRow(i))
    );
  });

  // GET /api/complaints/group scopes the Socrata query to the tier radius, the day and the complaint type.
  it("scopes the query to the tier radius, one day and one type", async () => {
    await server.request(BASE);
    expect(groupDetailSpy).toHaveBeenCalledWith(
      40.7484,
      -73.9857,
      RADIUS_TIERS.block.radiusMeters,
      expect.objectContaining({ type: "Noise - Residential", day: "2026-08-14" })
    );
  });

  // GET /api/complaints/group pages with limit and offset, asking Socrata for one extra row to detect a next page.
  it("pages, because the largest measured group is 4,978 rows", async () => {
    const { body, headers } = await server.request(`${BASE}&limit=50&offset=100`);
    expect(body).toHaveLength(50);
    expect(headers.get("x-complaints-offset")).toBe("100");
    // The provider is asked for one extra row as a has-more probe, rather than
    // paying for a second count query against the slowest upstream call.
    expect(groupDetailSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ limit: 51, offset: 100 })
    );
    expect(headers.get("x-complaints-has-more")).toBe("true");
  });

  // GET /api/complaints/group sets has-more to false when the extra probe row does not come back.
  it("says there is no next page when the probe row does not come back", async () => {
    groupDetailSpy.mockResolvedValue([complaintRow(0), complaintRow(1)]);
    const { body, headers } = await server.request(`${BASE}&limit=50`);
    expect(body).toHaveLength(2);
    expect(headers.get("x-complaints-has-more")).toBe("false");
  });

  // Socrata answers from replicas of differing freshness, so the cached group
  // count the client already holds can describe a different row set than this
  // response. Stating the total FROM these rows is what lets the drill-in show a
  // count that matches its own list instead of one that contradicts it.
  // GET /api/complaints/group states the exact total from the rows returned when on the last page.
  it("states the exact total, counted from the rows it returned, on the last page", async () => {
    groupDetailSpy.mockResolvedValue([complaintRow(0), complaintRow(1), complaintRow(2)]);
    const { body, headers } = await server.request(`${BASE}&limit=50`);
    expect(body).toHaveLength(3);
    expect(headers.get("x-complaints-total")).toBe("3");
  });

  // GET /api/complaints/group adds the offset to the returned rows to compute the total on a last page.
  it("counts the total from the offset, so a last page deep in a group is right", async () => {
    groupDetailSpy.mockResolvedValue([complaintRow(0), complaintRow(1)]);
    const { headers } = await server.request(`${BASE}&limit=50&offset=100`);
    expect(headers.get("x-complaints-total")).toBe("102");
  });

  // Mid-list the total is genuinely unknown from one page, and guessing it would
  // report a 50-row page as a 50-row group.
  // GET /api/complaints/group omits the total header when more pages remain.
  it("omits the total when there are further pages", async () => {
    const { headers } = await server.request(`${BASE}&limit=50`);
    expect(headers.get("x-complaints-has-more")).toBe("true");
    expect(headers.get("x-complaints-total")).toBeNull();
  });

  // GET /api/complaints/group returns 400 for a missing tier or day, impossible or malformed dates and an unknown complaint type.
  it.each([
    ["missing tier", "/api/complaints/group?lat=40.7484&lng=-73.9857&type=PLUMBING&day=2026-08-14"],
    ["missing day", "/api/complaints/group?lat=40.7484&lng=-73.9857&tier=block&type=PLUMBING"],
    ["impossible month", `${BASE.replace("2026-08-14", "2026-13-01")}`],
    ["impossible day of month", `${BASE.replace("2026-08-14", "2026-02-30")}`],
    ["malformed day", `${BASE.replace("2026-08-14", "14-08-2026")}`],
    [
      "unrecognised complaint type",
      "/api/complaints/group?lat=40.7484&lng=-73.9857&tier=block&type=Dragons&day=2026-08-14",
    ],
  ])("400s on %s", async (_label, path) => {
    const { status, body } = await server.request(path);
    expect(status).toBe(400);
    expect(body.error).toBeTypeOf("string");
  });
});

describe("app wiring", () => {
  // An unknown path returns a JSON 404 {error:not_found}, not an HTML page.
  it("404s unknown paths as JSON, not an HTML stack page", async () => {
    const { status, body } = await server.request("/api/nope");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not_found" });
  });

  // CORS reflects Access-Control-Allow-Origin and Vary: Origin for an allowlisted origin.
  it("reflects Access-Control-Allow-Origin for an allowlisted origin", async () => {
    const { headers } = await server.request("/health", {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(headers.get("vary")).toBe("Origin");
  });

  // CORS omits Access-Control-Allow-Origin for a non-allowlisted origin.
  it("omits Access-Control-Allow-Origin for a non-allowlisted origin", async () => {
    const { headers } = await server.request("/health", {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(headers.get("access-control-allow-origin")).toBeNull();
  });

  // An OPTIONS preflight to /api/score returns 204 and allows POST.
  it("answers CORS preflight with 204", async () => {
    const res = await fetch(`${server.baseUrl}/api/score`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

// --- AI explanation layer ----------------------------------------------------

describe("explanations on POST /api/score", () => {
  // POST /api/score gives both complaint sections a template explanation and never calls the AI.
  it("always carries a deterministic explanation — this endpoint never calls the AI", async () => {
    const { body } = await server.request("/api/score", {
      method: "POST",
      body: { lat: 40.7484, lng: -73.9857 },
    });

    for (const sub of [body.buildingHealth, body.blockQuality]) {
      expect(sub.explanation).toBeTypeOf("string");
      expect(sub.explanation.length).toBeGreaterThan(20);
      // Unlike `summary`, these six sections never get an AI upgrade — see
      // GET /api/explanation below, which now accepts only tier=overall.
      expect(sub.explanationSource).toBe("template");
    }
  });

  // POST /api/score serves template explanations on a cache miss and never calls the AI adapter.
  it("serves the template on a cache miss — the score never waits on an AI call", async () => {
    // No Mongo in this suite, so nothing is ever cached: every response here is
    // the fast path, which is exactly the path that must not touch the AI.
    const { body } = await server.request("/api/score", {
      method: "POST",
      body: { lat: 40.6944, lng: -73.9213 },
    });

    expect(body.buildingHealth.explanationSource).toBe("template");
    expect(body.blockQuality.explanationSource).toBe("template");
    // Asserted directly rather than by wall-clock time, which flakes on a slow machine.
    expect(aiSpy).not.toHaveBeenCalled();
  });

  // POST /api/score's block and building explanations each name their own tier and quote that tier's dominant bucket and real count.
  it("explains the tier it is attached to", async () => {
    const { body } = await server.request("/api/score", {
      method: "POST",
      body: { lat: 40.7484, lng: -73.9857 },
    });
    expect(body.blockQuality.explanation).toContain("for this block");
    expect(body.blockQuality.explanation).toContain("Noise stands out with 1653 complaints");
    expect(body.buildingHealth.explanation).toContain("for this building");
    expect(body.buildingHealth.explanation).toContain("Heat and hot water stands out with 12 complaints");
  });
});

describe("GET /api/explanation", () => {
  // The ONLY accepted tier now: building/block/transit/parks/bike/walkability
  // each get a deterministic explanation attached directly on /api/score
  // instead (see the describe block above) — none of them ever calls the AI,
  // so this endpoint has no per-tier or per-amenity slow path left to serve.

  // GET /api/explanation?tier=overall returns the AI summary, labelled ai, after one adapter call.
  it("returns the AI whole-report summary when the adapter succeeds", async () => {
    const { status, body } = await server.request(
      "/api/explanation?lat=40.7484&lng=-73.9857&tier=overall"
    );
    expect(status).toBe(200);
    expect(body.explanation).toBe("A generated sentence about this location.");
    expect(body.explanationSource).toBe("ai");
    expect(aiSpy).toHaveBeenCalledTimes(1);
  });

  // GET /api/explanation sends the AI adapter a `sections` array covering both complaint tiers.
  it("sends a `sections` array spanning both complaint tiers, not one tier's counts", async () => {
    await server.request("/api/explanation?lat=40.7484&lng=-73.9857&tier=overall");
    const input = aiSpy.mock.calls[0][0];
    expect(Object.keys(input)).toEqual(["sections"]);
    const labels = input.sections.map((s) => s.label);
    expect(labels).toContain("Building Health");
    expect(labels).toContain("Block Quality");
  });

  // GET /api/explanation returns 200 with a template explanation when the AI fails.
  it("200s with the template when the AI is unavailable, never an error", async () => {
    // CLAUDE.md: the demo must never show a broken state for this feature.
    aiSpy.mockRejectedValue(new Error("ollama unreachable"));
    const { status, body } = await server.request(
      "/api/explanation?lat=40.7484&lng=-73.9857&tier=overall"
    );
    expect(status).toBe(200);
    expect(body.explanationSource).toBe("template");
    expect(body.explanation.length).toBeGreaterThan(10);
  });

  // GET /api/explanation's body holds only explanation and explanationSource, leaking no failure detail.
  it("does not leak the internal failure reason to the client", async () => {
    aiSpy.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:11434"));
    const { body } = await server.request(
      "/api/explanation?lat=40.7484&lng=-73.9857&tier=overall"
    );
    expect(Object.keys(body).sort()).toEqual(["explanation", "explanationSource"]);
  });

  // GET /api/explanation still calls the AI when every complaint count is zero.
  it("does NOT skip the AI call when every complaint count is zero (unlike a single complaint tier's template)", async () => {
    countsSpy.mockImplementation(async () => ({
      counts: {
        heatHotWater: 0,
        unsanitaryCondition: 0,
        plumbing: 0,
        noise: 0,
        parking: 0,
        streetCondition: 0,
      },
    }));
    await server.request("/api/explanation?lat=40.7484&lng=-73.9857&tier=overall");
    expect(aiSpy).toHaveBeenCalledTimes(1);
  });

  // GET /api/explanation returns 400 for a missing or invalid tier, the no-longer-accepted block tier, missing coordinates and out-of-bounds coordinates.
  it.each([
    ["missing tier", "/api/explanation?lat=40.7484&lng=-73.9857"],
    ["invalid tier", "/api/explanation?lat=40.7484&lng=-73.9857&tier=roof"],
    ["a per-tier value that is no longer accepted here", "/api/explanation?lat=40.7484&lng=-73.9857&tier=block"],
    ["missing coords", "/api/explanation?tier=overall"],
    ["out of bounds", "/api/explanation?lat=34.05&lng=-118.24&tier=overall"],
  ])("400s on %s", async (_label, path) => {
    const { status, body } = await server.request(path);
    expect(status).toBe(400);
    expect(body.error).toBeTypeOf("string");
  });

  // GET /api/explanation returns 503 upstream_unavailable when Socrata counts cannot be fetched.
  it("503s when the upstream counts cannot be fetched", async () => {
    countsSpy.mockRejectedValue(new SocrataError("socrata 503: down", { status: 503 }));
    const { status, body } = await server.request(
      "/api/explanation?lat=40.7484&lng=-73.9857&tier=overall"
    );
    expect(status).toBe(503);
    expect(body.error).toBe("upstream_unavailable");
  });
});
