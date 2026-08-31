import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { startMongo } from "./helpers/mongoTestServer.js";
import { getDb } from "../src/providers/mongo.js";
import {
  CACHE_COLLECTION,
  COMPLAINT_GROUPS_COLLECTION,
  COMPLAINT_GROUPS_CACHE_LIMIT,
  RADIUS_TIERS,
} from "../src/config/constants.js";
import { SocrataError } from "../src/providers/socrata.js";

// The service is exercised against a REAL in-memory Mongo and a FAKE Socrata:
// the cache behaviour is the thing under test, and the network is the thing we
// must not touch.

const { fetchSpy, complaintsSpy, groupsSpy, groupDetailSpy, aiSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  complaintsSpy: vi.fn(),
  groupsSpy: vi.fn(),
  groupDetailSpy: vi.fn(),
  aiSpy: vi.fn(),
}));

vi.mock("../src/providers/socrata.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchCountsForTier: fetchSpy,
    fetchComplaints: complaintsSpy,
    fetchComplaintGroups: groupsSpy,
    fetchComplaintsForGroup: groupDetailSpy,
  };
});

// Mocked so the suite never reaches a real Ollama server on a developer machine
// that happens to have one running.
vi.mock("../src/providers/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, generateExplanation: aiSpy };
});

const {
  getCounts,
  buildScoreReport,
  buildExplanation,
  fetchComplaintPoints,
  fetchComplaintGroupList,
  fetchComplaintGroupDetail,
  isMockMode,
} = await import("../src/services/scoreService.js");

const COUNTS = {
  building: { heatHotWater: 12, unsanitaryCondition: 3, plumbing: 1 },
  block: { noise: 1653, parking: 402, streetCondition: 88 },
};

// Mirrors the real fetchCountsForTier's bucketStatusCounts shape — each
// bucket's triple sums back to that bucket's own COUNTS value above, the
// same invariant the real Socrata-derived data holds.
const STATUS_COUNTS = {
  building: {
    heatHotWater: { open: 5, "in-progress": 3, closed: 4 },
    unsanitaryCondition: { open: 1, "in-progress": 1, closed: 1 },
    plumbing: { open: 0, "in-progress": 0, closed: 1 },
  },
  block: {
    noise: { open: 600, "in-progress": 300, closed: 753 },
    parking: { open: 150, "in-progress": 50, closed: 202 },
    streetCondition: { open: 30, "in-progress": 10, closed: 48 },
  },
};

let mongo;

beforeAll(async () => {
  mongo = await startMongo();
});

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(CACHE_COLLECTION).deleteMany({});
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async (_lat, _lng, tier) => ({
    counts: COUNTS[tier],
    bucketStatusCounts: STATUS_COUNTS[tier],
  }));
  aiSpy.mockReset();
  aiSpy.mockResolvedValue("A generated sentence.");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cold call", () => {
  it("fetches both tiers and reports them as misses", async () => {
    const result = await getCounts(40.7484, -73.9857);

    expect(result.counts).toEqual(COUNTS);
    expect(result.cache).toEqual({ building: "miss", block: "miss" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("costs exactly the two HTTP calls CLAUDE.md budgets, one per tier", async () => {
    await getCounts(40.7484, -73.9857);
    const tiers = fetchSpy.mock.calls.map(([, , tier]) => tier).sort();
    expect(tiers).toEqual(["block", "building"]);
  });

  it("issues the two tier fetches in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    fetchSpy.mockImplementation(async (_lat, _lng, tier) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return { counts: COUNTS[tier] };
    });
    await getCounts(40.7484, -73.9857);
    expect(maxInFlight).toBe(2);
  });

  it("writes both tiers back to the cache", async () => {
    await getCounts(40.7484, -73.9857);
    const db = await getDb();
    const docs = await db
      .collection(CACHE_COLLECTION)
      .find({})
      .sort({ radiusTier: 1 })
      .toArray();

    expect(docs.map((d) => d.radiusTier)).toEqual(["block", "building"]);
    expect(docs.map((d) => d.counts)).toEqual([COUNTS.block, COUNTS.building]);
  });
});

describe("warm call", () => {
  it("serves the second call entirely from cache", async () => {
    await getCounts(40.7484, -73.9857);
    fetchSpy.mockClear();

    const second = await getCounts(40.7484, -73.9857);
    expect(second.counts).toEqual(COUNTS);
    expect(second.cache).toEqual({ building: "hit", block: "hit" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hits for a nearby coordinate that shares the rounded key", async () => {
    await getCounts(40.748412, -73.985712);
    fetchSpy.mockClear();

    const second = await getCounts(40.748389, -73.985731);
    expect(second.cache).toEqual({ building: "hit", block: "hit" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("misses for a different address", async () => {
    await getCounts(40.7484, -73.9857);
    fetchSpy.mockClear();

    const other = await getCounts(40.6944, -73.9213);
    expect(other.cache).toEqual({ building: "miss", block: "miss" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("fetches only the missing tier on a partial hit", async () => {
    await getCounts(40.7484, -73.9857, { tiers: ["block"] });
    fetchSpy.mockClear();

    const result = await getCounts(40.7484, -73.9857);
    expect(result.cache).toEqual({ building: "miss", block: "hit" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][2]).toBe("building");
    expect(result.counts).toEqual(COUNTS);
  });

  it("re-fetches and overwrites when forceRefresh is set", async () => {
    await getCounts(40.7484, -73.9857);
    fetchSpy.mockClear();
    const updated = { heatHotWater: 99, unsanitaryCondition: 0, plumbing: 0 };
    fetchSpy.mockImplementation(async (_lat, _lng, tier) => ({
      counts: tier === "building" ? updated : COUNTS[tier],
    }));

    const result = await getCounts(40.7484, -73.9857, { forceRefresh: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.counts.building).toEqual(updated);

    // The refreshed value must be what a subsequent cached read returns.
    fetchSpy.mockClear();
    const next = await getCounts(40.7484, -73.9857);
    expect(next.counts.building).toEqual(updated);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("coordinate handling", () => {
  it("queries Socrata with the ROUNDED coordinate, so a hit and a miss describe the same circle", async () => {
    await getCounts(40.748412, -73.985712);
    for (const [lat, lng] of fetchSpy.mock.calls) {
      expect(lat).toBe(40.7484);
      expect(lng).toBe(-73.9857);
    }
  });

  it("returns the rounded coordinate it actually used", async () => {
    const { coord } = await getCounts(40.748412, -73.985712);
    expect(coord).toEqual({ lat: 40.7484, lng: -73.9857 });
  });

  it("passes `now` through so the time window is testable end to end", async () => {
    const now = new Date("2026-08-15T00:00:00Z");
    await getCounts(40.7484, -73.9857, { now });
    for (const call of fetchSpy.mock.calls) {
      expect(call[3]).toMatchObject({ now });
    }

    const db = await getDb();
    const doc = await db.collection(CACHE_COLLECTION).findOne({});
    expect(doc.createdAt.toISOString()).toBe(now.toISOString());
  });
});

describe("count integrity", () => {
  it("returns one number per bucket, never NaN", async () => {
    const { counts } = await getCounts(40.7484, -73.9857);
    for (const tier of Object.keys(RADIUS_TIERS)) {
      for (const value of Object.values(counts[tier])) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("round-trips zero counts through the cache as a hit", async () => {
    const zeros = { heatHotWater: 0, unsanitaryCondition: 0, plumbing: 0 };
    fetchSpy.mockImplementation(async (_lat, _lng, tier) => ({
      counts: tier === "building" ? zeros : COUNTS.block,
    }));

    await getCounts(40.7484, -73.9857);
    fetchSpy.mockClear();

    const second = await getCounts(40.7484, -73.9857);
    // An all-zero building result is real data (M4 flags it low-confidence),
    // so it must come back as a hit rather than being re-fetched forever.
    expect(second.cache.building).toBe("hit");
    expect(second.counts.building).toEqual(zeros);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  it("propagates a Socrata failure rather than caching a bogus result", async () => {
    fetchSpy.mockRejectedValue(new SocrataError("socrata 500"));

    await expect(getCounts(40.7484, -73.9857)).rejects.toThrow(SocrataError);

    const db = await getDb();
    expect(await db.collection(CACHE_COLLECTION).countDocuments()).toBe(0);
  });

  it("still returns the tier that succeeded to the cache when the other fails", async () => {
    fetchSpy.mockImplementation(async (_lat, _lng, tier) => {
      if (tier === "building") throw new SocrataError("socrata 500");
      return { counts: COUNTS.block };
    });

    await expect(getCounts(40.7484, -73.9857)).rejects.toThrow(SocrataError);

    // Promise.all rejects, but the block fetch that already completed should
    // have persisted — so a retry only pays for the failed tier.
    const db = await getDb();
    const docs = await db.collection(CACHE_COLLECTION).find({}).toArray();
    expect(docs.map((d) => d.radiusTier)).toEqual(["block"]);
  });

  it("serves from Socrata when Mongo is not configured at all", async () => {
    const uri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      const result = await getCounts(40.7484, -73.9857);
      expect(result.counts).toEqual(COUNTS);
      expect(result.cache).toEqual({ building: "miss", block: "miss" });
    } finally {
      process.env.MONGODB_URI = uri;
    }
  });
});

// --- M5: the whole report, not just the counts -------------------------------

describe("buildScoreReport", () => {
  it("scores the cached counts and reports where they came from", async () => {
    const report = await buildScoreReport(40.7484, -73.9857);

    expect(report.address).toBeNull();
    expect(report.buildingHealth.counts).toEqual(COUNTS.building);
    expect(report.blockQuality.counts).toEqual(COUNTS.block);
    expect(report.meta.cache).toEqual({ building: "miss", block: "miss" });
    // Rounded, not the caller's raw coordinate — the circle we actually queried.
    expect(report.meta.coord).toEqual({ lat: 40.7484, lng: -73.9857 });
  });

  it("attaches bucketStatusCounts from the provider onto each complaint section", async () => {
    const report = await buildScoreReport(40.7484, -73.9857);
    expect(report.buildingHealth.bucketStatusCounts).toEqual(STATUS_COUNTS.building);
    expect(report.blockQuality.bucketStatusCounts).toEqual(STATUS_COUNTS.block);
  });

  it("round-trips bucketStatusCounts through the cache on a warm report", async () => {
    await buildScoreReport(40.7484, -73.9857);
    fetchSpy.mockClear();

    const warm = await buildScoreReport(40.7484, -73.9857);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warm.buildingHealth.bucketStatusCounts).toEqual(STATUS_COUNTS.building);
    expect(warm.blockQuality.bucketStatusCounts).toEqual(STATUS_COUNTS.block);
  });

  it("serves a warm report from cache without touching the upstream", async () => {
    await buildScoreReport(40.7484, -73.9857);
    fetchSpy.mockClear();

    const warm = await buildScoreReport(40.7484, -73.9857);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warm.meta.cache).toEqual({ building: "hit", block: "hit" });
  });

  it("loads a baseline, so scores are comparable rather than raw counts", async () => {
    const report = await buildScoreReport(40.7484, -73.9857);
    expect(report.meta.baselineVersion).toBeTypeOf("string");
    expect(report.buildingHealth.confidenceReason).not.toBe("no_baseline");
  });

  it("ranks a quiet address above a loud one", async () => {
    // The end-to-end property that matters: the report has to discriminate.
    fetchSpy.mockImplementation(async (_lat, _lng, tier) => ({
      counts:
        tier === "block"
          ? { noise: 40, parking: 60, streetCondition: 5 }
          : COUNTS.building,
    }));
    const quiet = await buildScoreReport(40.5795, -74.1502);

    fetchSpy.mockImplementation(async (_lat, _lng, tier) => ({
      counts:
        tier === "block"
          ? { noise: 9000, parking: 7000, streetCondition: 500 }
          : COUNTS.building,
    }));
    const loud = await buildScoreReport(40.6944, -73.9213);

    expect(quiet.blockQuality.score).toBeGreaterThan(loud.blockQuality.score);
  });

  it("propagates an upstream failure instead of inventing a score", async () => {
    // A fabricated score during an outage is worse than an error: the renter
    // cannot tell it apart from a real one. M6 adds stale-cache fallback.
    fetchSpy.mockRejectedValue(new SocrataError("socrata 503: down", { status: 503 }));
    await expect(buildScoreReport(40.7128, -74.0060)).rejects.toThrow(SocrataError);
  });
});

describe("fetchComplaintPoints", () => {
  beforeEach(() => {
    complaintsSpy.mockReset();
  });

  it("passes the radius and limit through and reports no truncation", async () => {
    complaintsSpy.mockResolvedValue([{ type: "Noise - Residential" }]);
    const result = await fetchComplaintPoints(40.7484, -73.9857, 350, { limit: 100 });

    expect(complaintsSpy).toHaveBeenCalledWith(
      40.7484,
      -73.9857,
      350,
      expect.objectContaining({ limit: 100 })
    );
    expect(result.truncated).toBe(false);
    expect(result.points).toHaveLength(1);
  });

  it("flags truncation when the upstream fills the row cap", async () => {
    complaintsSpy.mockResolvedValue(Array.from({ length: 100 }, () => ({})));
    const result = await fetchComplaintPoints(40.7484, -73.9857, 350, { limit: 100 });
    expect(result.truncated).toBe(true);
  });

  // Every other read on the report describes the rounded circle. When this one
  // used the raw coordinate, "Recent complaints" could list a complaint the
  // grouped browser beside it did not have.
  it("queries the rounded coordinate, like the rest of the report", async () => {
    complaintsSpy.mockResolvedValue([]);
    await fetchComplaintPoints(40.74839999, -73.98571234, 350, { limit: 100 });
    expect(complaintsSpy).toHaveBeenCalledWith(40.7484, -73.9857, 350, expect.any(Object));
  });

  it("is not cached — the cache holds counts, never rows", async () => {
    complaintsSpy.mockResolvedValue([]);
    await fetchComplaintPoints(40.7484, -73.9857, 350);
    await fetchComplaintPoints(40.7484, -73.9857, 350);
    expect(complaintsSpy).toHaveBeenCalledTimes(2);

    const db = await getDb();
    const docs = await db.collection(CACHE_COLLECTION).find({}).toArray();
    expect(docs).toHaveLength(0);
  });
});

describe("fetchComplaintGroupList", () => {
  const TUPLES = [
    { day: "2026-08-14", type: "Noise - Residential", statusBucket: "closed", count: 7 },
    { day: "2026-08-14", type: "Noise - Residential", statusBucket: "open", count: 3 },
    { day: "2026-08-14", type: "Illegal Parking", statusBucket: "closed", count: 2 },
    { day: "2024-11-02", type: "Street Condition", statusBucket: "open", count: 5 },
  ];

  beforeEach(async () => {
    groupsSpy.mockReset();
    groupsSpy.mockResolvedValue(TUPLES);
    const db = await getDb();
    await db.collection(COMPLAINT_GROUPS_COLLECTION).deleteMany({});
  });

  it("collapses (day, type, status) tuples into one row per (day, type)", async () => {
    const { rows } = await fetchComplaintGroupList(40.7484, -73.9857, 350, { tier: "block" });
    const noise = rows.find((r) => r.type === "Noise - Residential");
    expect(noise.counts).toEqual({ open: 3, "in-progress": 0, closed: 7 });
    expect(noise.total).toBe(10);
  });

  it("counts distinct (day, type) pairs as the total, not the complaints", async () => {
    const { total } = await fetchComplaintGroupList(40.7484, -73.9857, 350, { tier: "block" });
    expect(total).toBe(3);
  });

  it("orders newest day first, then by type, so offset paging is stable", async () => {
    const { rows } = await fetchComplaintGroupList(40.7484, -73.9857, 350, { tier: "block" });
    expect(rows.map((r) => `${r.day}|${r.type}`)).toEqual([
      "2026-08-14|Illegal Parking",
      "2026-08-14|Noise - Residential",
      "2024-11-02|Street Condition",
    ]);
  });

  it("drops a group whose only complaints are of another status", async () => {
    const { rows } = await fetchComplaintGroupList(40.7484, -73.9857, 350, {
      tier: "block",
      status: "open",
    });
    expect(rows.map((r) => r.type)).not.toContain("Illegal Parking");
  });

  // The cache keys on the rounded coordinate; filling it from the raw one let a
  // hit and a miss describe different circles, and left the drill-in describing
  // a third.
  it("fills the cache from the same rounded coordinate it keys on", async () => {
    await fetchComplaintGroupList(40.74839999, -73.98571234, 350, { tier: "block" });
    expect(groupsSpy).toHaveBeenCalledWith(40.7484, -73.9857, 350, expect.any(Object));
  });

  it("fills at the cache limit rather than the caller's page size", async () => {
    await fetchComplaintGroupList(40.7484, -73.9857, 350, { tier: "block", limit: 25 });
    expect(groupsSpy).toHaveBeenCalledWith(
      40.7484,
      -73.9857,
      350,
      expect.objectContaining({ limit: COMPLAINT_GROUPS_CACHE_LIMIT })
    );
  });

  it("serves the second call from Mongo without touching Socrata", async () => {
    await fetchComplaintGroupList(40.7484, -73.9857, 350, { tier: "block" });
    const second = await fetchComplaintGroupList(40.7484, -73.9857, 350, { tier: "block" });
    expect(groupsSpy).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
  });

  it("does not read or write the cache for an ad-hoc radius", async () => {
    // The key has no radius dimension, so a 100m request must not collide with
    // the tier's own 350m entry.
    await fetchComplaintGroupList(40.7484, -73.9857, 100, { tier: "block" });
    const db = await getDb();
    expect(await db.collection(COMPLAINT_GROUPS_COLLECTION).countDocuments()).toBe(0);
  });

  it("flags truncation when the fill hits the cache limit", async () => {
    groupsSpy.mockResolvedValue(
      Array.from({ length: COMPLAINT_GROUPS_CACHE_LIMIT }, (_, i) => ({
        day: "2026-08-14",
        type: `Type ${i}`,
        statusBucket: "closed",
        count: 1,
      }))
    );
    const { truncated } = await fetchComplaintGroupList(40.7484, -73.9857, 350, { tier: "block" });
    expect(truncated).toBe(true);
  });
});

describe("fetchComplaintGroupDetail", () => {
  beforeEach(() => {
    groupDetailSpy.mockReset();
  });

  it("asks for one row beyond the page as a has-more probe", async () => {
    groupDetailSpy.mockResolvedValue([]);
    await fetchComplaintGroupDetail(40.7484, -73.9857, 350, {
      type: "Noise - Residential",
      day: "2026-08-14",
      limit: 50,
      offset: 0,
    });
    expect(groupDetailSpy).toHaveBeenCalledWith(
      40.7484,
      -73.9857,
      350,
      expect.objectContaining({ limit: 51 })
    );
  });

  it("trims the probe row back off the page it returns", async () => {
    groupDetailSpy.mockResolvedValue(
      Array.from({ length: 4 }, () => ({ type: "Noise - Residential", statusBucket: "open" }))
    );
    const result = await fetchComplaintGroupDetail(40.7484, -73.9857, 350, {
      type: "Noise - Residential",
      day: "2026-08-14",
      limit: 3,
    });
    expect(result.points).toHaveLength(3);
    expect(result.hasMore).toBe(true);
  });

  // The regression this endpoint was fixed for: the status used to narrow the
  // page AFTER it was sliced, so a day whose complaints were mostly of another
  // status came back short — or empty — under a header stating the real count.
  it("filters by status upstream rather than narrowing the page it fetched", async () => {
    groupDetailSpy.mockResolvedValue([]);
    await fetchComplaintGroupDetail(40.7484, -73.9857, 350, {
      type: "Noise - Residential",
      day: "2026-08-14",
      status: "open",
      limit: 25,
    });
    expect(groupDetailSpy).toHaveBeenCalledWith(
      40.7484,
      -73.9857,
      350,
      expect.objectContaining({ status: "open" })
    );
  });

  it("returns a full page under a status filter instead of a filtered remnant", async () => {
    // Upstream has already applied the filter, so every row comes back matching.
    groupDetailSpy.mockResolvedValue(
      Array.from({ length: 26 }, () => ({ type: "Noise - Residential", statusBucket: "open" }))
    );
    const result = await fetchComplaintGroupDetail(40.7484, -73.9857, 350, {
      type: "Noise - Residential",
      day: "2026-08-14",
      status: "open",
      limit: 25,
    });
    expect(result.points).toHaveLength(25);
    expect(result.hasMore).toBe(true);
  });

  it("queries the rounded coordinate, so a drill-in matches the group it came from", async () => {
    groupDetailSpy.mockResolvedValue([]);
    await fetchComplaintGroupDetail(40.74839999, -73.98571234, 350, {
      type: "Noise - Residential",
      day: "2026-08-14",
    });
    expect(groupDetailSpy).toHaveBeenCalledWith(
      40.7484,
      -73.9857,
      350,
      expect.any(Object)
    );
  });
});

describe("mock mode", () => {
  afterEach(() => {
    delete process.env.USE_MOCK_DATA;
  });

  it("is off unless explicitly enabled", () => {
    expect(isMockMode()).toBe(false);
  });

  it("serves mock data without touching Socrata or the cache", async () => {
    process.env.USE_MOCK_DATA = "1";
    const report = await buildScoreReport(40.7484, -73.9857);

    expect(report.meta.mock).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const db = await getDb();
    expect(await db.collection(CACHE_COLLECTION).countDocuments()).toBe(0);
  });

  it("returns the same shape as the live path", async () => {
    const live = await buildScoreReport(40.7484, -73.9857);
    process.env.USE_MOCK_DATA = "1";
    const mock = await buildScoreReport(40.7484, -73.9857);

    expect(Object.keys(mock).sort()).toEqual(Object.keys(live).sort());
    for (const key of ["buildingHealth", "blockQuality"]) {
      expect(Object.keys(mock[key]).sort()).toEqual(Object.keys(live[key]).sort());
    }
  });
});

// --- the two-call explanation pattern ---------------------------------------
//
// buildExplanation is now the ONLY explanation the AI adapter ever
// generates — the whole-report summary. building/block/transit/parks/bike/
// walkability each get a deterministic "Why this score?" attached directly
// on /api/score (see the "per-section explanations are always the template"
// describe block below), so there is no per-tier or per-amenity slow path
// left to test here.

describe("buildExplanation (the slow path, overall only)", () => {
  it("generates and caches an AI summary, via the amenity cache path (radiusTier: overall)", async () => {
    const result = await buildExplanation(40.7484, -73.9857);

    expect(result.explanationSource).toBe("ai");
    expect(result.explanation).toBe("A generated sentence.");
    expect(result.cached).toBe(false);

    const db = await getDb();
    const doc = await db.collection(CACHE_COLLECTION).findOne({ radiusTier: "overall" });
    expect(doc.explanation).toBe("A generated sentence.");
    expect(doc.explanationSource).toBe("ai");
  });

  it("sends a `sections` array covering both complaint tiers to the adapter", async () => {
    await buildExplanation(40.7484, -73.9857);
    const input = aiSpy.mock.calls[0][0];
    const labels = input.sections.map((s) => s.label);
    expect(labels).toContain("Building Health");
    expect(labels).toContain("Block Quality");
  });

  it("serves a second request from cache without regenerating", async () => {
    await buildExplanation(40.7484, -73.9857);
    aiSpy.mockClear();

    const second = await buildExplanation(40.7484, -73.9857);
    expect(second.cached).toBe(true);
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("does not cache a template fallback", async () => {
    // Caching it would make /api/score believe the AI had already run and skip
    // its second call forever.
    aiSpy.mockRejectedValue(new Error("ai down"));
    const result = await buildExplanation(40.7484, -73.9857);
    expect(result.explanationSource).toBe("template");

    const db = await getDb();
    const doc = await db.collection(CACHE_COLLECTION).findOne({ radiusTier: "overall" });
    expect(doc?.explanation).toBeUndefined();
  });

  it("regenerates rather than serving a cached summary whose counts have since been refreshed", async () => {
    // This is the staleness bug: the overall summary and the complaint counts
    // it describes sit on independent 24h TTLs, ticking from independent
    // last-write times, so nothing else would notice one going stale relative
    // to the other. Explicit `now` values make the ordering deterministic
    // instead of relying on wall-clock drift between two `new Date()` calls.
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const t1 = new Date("2026-01-02T00:00:00.000Z");

    await getCounts(40.7484, -73.9857, { now: t0 }); // warms both tiers' counts at t0
    await buildExplanation(40.7484, -73.9857); // generates + caches the summary, basedOn t0
    expect((await buildScoreReport(40.7484, -73.9857)).summary.explanationSource).toBe("ai");

    // Simulates the block counts doc expiring and being refetched — forceRefresh
    // bypasses the cache read the same way an expired TTL would, landing a new
    // createdAt (t1) even though the counts VALUES are unchanged (the default
    // fetchSpy mock always returns the same COUNTS fixture). The staleness
    // check is timestamp-based, not value-based, on purpose: it must catch a
    // refresh even when the refreshed numbers happen to match the old ones.
    await getCounts(40.7484, -73.9857, { tiers: ["block"], forceRefresh: true, now: t1 });

    aiSpy.mockClear();
    const after = await buildScoreReport(40.7484, -73.9857);
    // The stale cached summary is discarded — template until asked again.
    expect(after.summary.explanationSource).toBe("template");

    const regenerated = await buildExplanation(40.7484, -73.9857);
    expect(aiSpy).toHaveBeenCalledTimes(1);
    expect(regenerated.explanationSource).toBe("ai");
  });
});

describe("per-section explanations are always the template", () => {
  it("never calls the AI, however cold the cache", async () => {
    await buildScoreReport(40.7484, -73.9857);
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("attaches a template explanation to every complaint section, unconditionally", async () => {
    const report = await buildScoreReport(40.7484, -73.9857);
    expect(report.blockQuality.explanationSource).toBe("template");
    expect(report.buildingHealth.explanationSource).toBe("template");
    expect(report.blockQuality.explanation.length).toBeGreaterThan(0);
  });

  it("stays the template even once a whole-report AI summary has been generated for the same address", async () => {
    await buildExplanation(40.7484, -73.9857);

    const warm = await buildScoreReport(40.7484, -73.9857);
    expect(warm.blockQuality.explanationSource).toBe("template");
    expect(warm.buildingHealth.explanationSource).toBe("template");
    // The one section that DID pick up the AI text.
    expect(warm.summary.explanationSource).toBe("ai");
  });

  it("attaches a template `summary` on a cold report, and the cached AI summary once one exists", async () => {
    const cold = await buildScoreReport(40.7484, -73.9857);
    expect(cold.summary.explanationSource).toBe("template");
    expect(cold.summary.explanation.length).toBeGreaterThan(0);

    await buildExplanation(40.7484, -73.9857);

    const warm = await buildScoreReport(40.7484, -73.9857);
    expect(warm.summary.explanationSource).toBe("ai");
    expect(warm.summary.explanation).toBe("A generated sentence.");
  });
});
