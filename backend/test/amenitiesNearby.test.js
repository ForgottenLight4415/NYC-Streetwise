import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestServer } from "./helpers/testServer.js";

// Mocked the same way walkabilityService.test.js mocks it — this route's
// walkability path is CACHE-ONLY (see amenityService.js's
// getNearbyWalkabilityInstances), so mocking the cache read is what lets a
// test control "nothing cached yet" vs. "already warm from a prior /api/score
// call" without standing up a real Mongo instance.
const { readWalkabilityPlacesSpy } = vi.hoisted(() => ({
  readWalkabilityPlacesSpy: vi.fn(),
}));

vi.mock("../src/providers/cache.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readWalkabilityPlaces: readWalkabilityPlacesSpy };
});

let server;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  readWalkabilityPlacesSpy.mockReset().mockResolvedValue(null);
});

// 14 St-Union Sq — a real, dense hub (multiple subway entrances, a park
// across the street, several bus stops) so the transit/parks/bike cases
// below exercise the actual committed datasets rather than a fixture.
const UNION_SQ = { lat: 40.735736, lng: -73.990568 };

describe("GET /api/amenities/nearby — validation", () => {
  it("400s a missing tier", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&bucket=park`
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_tier");
  });

  it("400s an invalid tier", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=building&bucket=park`
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_tier");
  });

  it("400s a missing bucket", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=parks`
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_bucket");
  });

  it("400s a bucket that doesn't belong to the given tier", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=parks&bucket=subway`
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_bucket");
  });

  it("400s an out-of-bounds coordinate", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=0&lng=0&tier=parks&bucket=park`
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("out_of_bounds");
  });

  it.each(["bikeLane", "protectedLane"])(
    "400s %s as bucket_not_applicable — a resampled line, not discrete instances",
    async (bucket) => {
      const res = await server.request(
        `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=bike&bucket=${bucket}`
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("bucket_not_applicable");
    }
  );
});

describe("GET /api/amenities/nearby — real committed data (transit/parks/bike)", () => {
  it("returns multiple subway instances near a dense hub, sorted ascending, all within radius", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=transit&bucket=subway`
    );
    expect(res.status).toBe(200);
    expect(res.body.radiusMeters).toBe(800);
    expect(Array.isArray(res.body.instances)).toBe(true);
    // 14 St-Union Sq has several entrances — a real multi-instance case, not
    // just the single nearest one getAmenityMetrics() would report.
    expect(res.body.instances.length).toBeGreaterThan(1);

    for (const inst of res.body.instances) {
      expect(inst.meters).toBeLessThanOrEqual(800);
      expect(typeof inst.lat).toBe("number");
      expect(typeof inst.lng).toBe("number");
    }
    const sortedCopy = [...res.body.instances].sort((a, b) => a.meters - b.meters);
    expect(res.body.instances).toEqual(sortedCopy);
    expect(typeof res.body.truncated).toBe("boolean");
  });

  it("returns at least one park instance near Union Square itself", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=parks&bucket=park`
    );
    expect(res.status).toBe(200);
    expect(res.body.instances.length).toBeGreaterThanOrEqual(1);
    expect(res.body.instances[0].meters).toBeLessThanOrEqual(800);
  });

  it("caps the returned array at 50 regardless of how many actually exist", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=transit&bucket=bus`
    );
    expect(res.status).toBe(200);
    expect(res.body.instances.length).toBeLessThanOrEqual(50);
    if (res.body.instances.length < 50) expect(res.body.truncated).toBe(false);
  });
});

describe("GET /api/amenities/nearby — walkability (cache-only)", () => {
  it("answers [] rather than making a live Places call when nothing is cached yet", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=walkability&bucket=grocery`
    );
    expect(res.status).toBe(200);
    expect(res.body.instances).toEqual([]);
    expect(res.body.truncated).toBe(false);
    expect(readWalkabilityPlacesSpy).toHaveBeenCalled();
  });

  it("filters cached places into the requested bucket and sorts nearest first", async () => {
    readWalkabilityPlacesSpy.mockResolvedValue([
      { lat: UNION_SQ.lat + 0.002, lng: UNION_SQ.lng, types: ["grocery_store"], name: "Far Grocer" },
      { lat: UNION_SQ.lat + 0.0002, lng: UNION_SQ.lng, types: ["grocery_store"], name: "Near Grocer" },
      { lat: UNION_SQ.lat + 0.0001, lng: UNION_SQ.lng, types: ["cafe"], name: "Some Cafe" },
    ]);

    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=walkability&bucket=grocery`
    );
    expect(res.status).toBe(200);
    expect(res.body.instances.map((i) => i.name)).toEqual(["Near Grocer", "Far Grocer"]);
  });
});
