import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestServer } from "./helpers/testServer.js";
import {
  RADIUS_TIERS,
  TREND_WINDOW_OPTIONS,
  TREND_DEFAULT_MONTHS,
} from "../src/config/constants.js";

// End-to-end over real HTTP. Socrata is FAKED; the route, validation and the
// zero-fill in scoreService are real — that seam is the whole point of the
// endpoint, so it is what gets exercised.

const { trendSpy } = vi.hoisted(() => ({ trendSpy: vi.fn() }));

vi.mock("../src/providers/socrata.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchMonthlyTrend: trendSpy };
});

let server;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  trendSpy.mockReset();
  trendSpy.mockResolvedValue([]);
});

const NYC = "lat=40.7198&lng=-73.9888";

describe("GET /api/trend", () => {
  // GET /api/trend defaults to the 9-month window with one point per month.
  it("defaults to the 9-month window", async () => {
    const { status, body } = await server.request(`/api/trend?${NYC}&tier=block`);
    expect(status).toBe(200);
    expect(body.months).toBe(TREND_DEFAULT_MONTHS);
    expect(body.points).toHaveLength(TREND_DEFAULT_MONTHS);
  });

  // GET /api/trend returns one point per month, ascending, unique and YYYY-MM formatted, for every offered window.
  it("returns one point per month, oldest first, for every offered window", async () => {
    for (const months of TREND_WINDOW_OPTIONS) {
      const { status, body } = await server.request(
        `/api/trend?${NYC}&tier=block&months=${months}`
      );
      expect(status).toBe(200);
      expect(body.months).toBe(months);
      expect(body.points).toHaveLength(months);

      const keys = body.points.map((p) => p.month);
      expect([...keys].sort()).toEqual(keys); // ascending
      expect(new Set(keys).size).toBe(months); // no repeats
      for (const key of keys) expect(key).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    }
  });

  // trendCacheKey rounds, so the query has to as well — otherwise a hit and a
  // miss describe different circles, and this series is what the report's
  // "Show all N" total is counted from.
  // GET /api/trend queries Socrata with the coordinate rounded the same way as the trend cache key.
  it("queries Socrata with the rounded coordinate its cache keys on", async () => {
    await server.request("/api/trend?lat=40.74839999&lng=-73.98571234&tier=block");
    expect(trendSpy).toHaveBeenCalledWith(40.7484, -73.9857, expect.any(Number), expect.any(Object));
  });

  // GET /api/trend echoes the requested tier and its radiusMeters in the response.
  it("echoes the tier's radius so the caller need not hardcode it", async () => {
    for (const tier of ["building", "block"]) {
      const { body } = await server.request(`/api/trend?${NYC}&tier=${tier}`);
      expect(body.tier).toBe(tier);
      expect(body.radiusMeters).toBe(RADIUS_TIERS[tier].radiusMeters);
    }
  });

  // GET /api/trend fills months Socrata omits with count 0, keeps returned counts, and sums the total.
  it("zero-fills months Socrata omits and keeps the ones it returns", async () => {
    // Socrata emits no row for a month with no complaints. The series still has
    // to be continuous, or the chart silently compresses its own time axis.
    const now = new Date();
    const monthKey = (back) => {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    };
    trendSpy.mockResolvedValue([
      { month: monthKey(0), count: 7 },
      { month: monthKey(2), count: 3 },
    ]);

    const { body } = await server.request(`/api/trend?${NYC}&tier=block&months=3`);
    expect(body.points).toEqual([
      { month: monthKey(2), count: 3 },
      { month: monthKey(1), count: 0 },
      { month: monthKey(0), count: 7 },
    ]);
    expect(body.total).toBe(10);
  });

  // GET /api/trend ignores Socrata rows for months outside the requested window.
  it("ignores months outside the requested window", async () => {
    trendSpy.mockResolvedValue([{ month: "1999-01", count: 999 }]);
    const { body } = await server.request(`/api/trend?${NYC}&tier=block&months=3`);
    expect(body.total).toBe(0);
    expect(body.points.every((p) => p.count === 0)).toBe(true);
  });

  // GET /api/trend passes the coordinate, tier radius, tier and months through to the Socrata provider.
  it("passes the tier and window down to the provider", async () => {
    await server.request(`/api/trend?${NYC}&tier=building&months=18`);
    expect(trendSpy).toHaveBeenCalledOnce();
    const [lat, lng, radius, opts] = trendSpy.mock.calls[0];
    expect(lat).toBeCloseTo(40.7198);
    expect(lng).toBeCloseTo(-73.9888);
    expect(radius).toBe(RADIUS_TIERS.building.radiusMeters);
    expect(opts).toMatchObject({ tier: "building", months: 18 });
  });

  describe("edge cache headers", () => {
    // GET /api/trend sends a one-hour public edge Cache-Control header on success.
    it("is cacheable for an hour, on top of its own 24h Mongo cache", async () => {
      const { status, headers } = await server.request(`/api/trend?${NYC}&tier=block`);
      expect(status).toBe(200);
      expect(headers.get("cache-control")).toBe(
        "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400"
      );
    });

    // GET /api/trend sends no Cache-Control header on a rejected (400) request.
    it("does not put a cache directive on a rejected request", async () => {
      // The series is labelled by calendar month relative to now, so an error
      // pinned at the edge would outlast the input that caused it.
      const { status, headers } = await server.request(`/api/trend?${NYC}&tier=nonsense`);
      expect(status).toBe(400);
      expect(headers.get("cache-control")).toBeNull();
    });
  });

  describe("validation", () => {
    // GET /api/trend returns 400 invalid_months for windows outside the offered set.
    it("rejects a window outside the offered set", async () => {
      for (const bad of [7, 36, 0, -3, 2.5]) {
        const { status, body } = await server.request(
          `/api/trend?${NYC}&tier=block&months=${bad}`
        );
        expect(status).toBe(400);
        expect(body.error).toBe("invalid_months");
      }
    });

    // GET /api/trend returns 400 for a non-numeric months value.
    it("rejects a non-numeric window", async () => {
      const { status } = await server.request(`/api/trend?${NYC}&tier=block&months=nine`);
      expect(status).toBe(400);
    });

    // GET /api/trend returns 400 missing_tier when no tier is given.
    it("requires a tier", async () => {
      const { status, body } = await server.request(`/api/trend?${NYC}`);
      expect(status).toBe(400);
      expect(body.error).toBe("missing_tier");
    });

    // GET /api/trend returns 400 invalid_tier for an unknown tier.
    it("rejects an unknown tier", async () => {
      const { status, body } = await server.request(`/api/trend?${NYC}&tier=borough`);
      expect(status).toBe(400);
      expect(body.error).toBe("invalid_tier");
    });

    // GET /api/trend returns 400 for coordinates outside NYC.
    it("rejects coordinates outside NYC", async () => {
      const { status } = await server.request("/api/trend?lat=51.5&lng=-0.12&tier=block");
      expect(status).toBe(400);
    });
  });
});
