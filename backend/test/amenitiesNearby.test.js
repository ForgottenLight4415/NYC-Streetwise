import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestServer } from "./helpers/testServer.js";
import { AMENITY_SUBWAY_COMPLEX_CAP, AMENITY_BUS_STOP_CAP } from "../src/config/constants.js";

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

// 34 St-Herald Sq — every one of Union Sq's subway entrances shares ONE
// complex_id (they're one official MTA complex: L, 4/5/6, and N/Q/R/W all
// under 602), which correctly collapses to a single grouped instance under
// the new complex-clustering logic — not a useful case for testing that
// MULTIPLE distinct complexes come back. Herald Sq has several genuinely
// separate complexes within 800m (its own B/D/F/M+N/Q/R/W complex, Penn
// Station, 28 St, Bryant Pk, Times Sq) so it exercises the cap and dedup
// paths instead.
const HERALD_SQ = { lat: 40.7484, lng: -73.9878 };

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
  it("groups Union Sq's own entrances into ONE instance — they share a single MTA complex_id", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=transit&bucket=subway`
    );
    expect(res.status).toBe(200);
    expect(res.body.radiusMeters).toBe(800);
    expect(Array.isArray(res.body.instances)).toBe(true);
    // L, 4/5/6, and N/Q/R/W at Union Sq are three constituent stations under
    // ONE official complex_id — grouping by complex, not by raw entrance, is
    // the whole point of this change, so the NEAREST instance is one card
    // with all of those routes rather than split by nearest platform. A
    // second, genuinely different complex (14 St/6 Av — the F/L/M/1/2/3
    // stop a couple blocks west) legitimately falls inside the same 800m
    // radius too, so the list isn't asserted to be length 1 outright.
    expect(res.body.instances.length).toBeGreaterThanOrEqual(1);
    expect(res.body.instances[0].name).toBe("14 St-Union Sq");
    expect(res.body.instances[0].routes).toEqual(
      expect.arrayContaining(["4", "5", "6", "L", "N", "Q", "R", "W"])
    );
    expect(res.body.instances[0].meters).toBeLessThanOrEqual(800);
    // Union Sq's own complex has several real entrances — every one of their
    // distances rides along on `entrances`, ascending, for the frontend's
    // "[N entrances]" hover breakdown. The first (smallest) value is always
    // the same as the instance's own `meters`.
    const entrances = res.body.instances[0].entrances;
    expect(Array.isArray(entrances)).toBe(true);
    expect(entrances.length).toBeGreaterThan(1);
    expect(entrances[0]).toBe(res.body.instances[0].meters);
    expect([...entrances].sort((a, b) => a - b)).toEqual(entrances);
  });

  it("caps subway complexes at AMENITY_SUBWAY_COMPLEX_CAP near a hub with several distinct complexes, sorted ascending, deduped by route overlap", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${HERALD_SQ.lat}&lng=${HERALD_SQ.lng}&tier=transit&bucket=subway`
    );
    expect(res.status).toBe(200);
    expect(res.body.instances.length).toBeGreaterThan(1);
    expect(res.body.instances.length).toBeLessThanOrEqual(AMENITY_SUBWAY_COMPLEX_CAP);
    expect(res.body.truncated).toBe(true); // more distinct complexes exist within 800m than the cap

    for (const inst of res.body.instances) {
      expect(inst.meters).toBeLessThanOrEqual(800);
      expect(typeof inst.lat).toBe("number");
      expect(typeof inst.lng).toBe("number");
      expect(Array.isArray(inst.routes)).toBe(true);
    }
    const sortedCopy = [...res.body.instances].sort((a, b) => a.meters - b.meters);
    expect(res.body.instances).toEqual(sortedCopy);

    // Same-line dedup: no kept complex's route set is a subset of routes
    // already covered by a closer, earlier one — each one earns its place
    // by adding at least one line the closer ones don't already reach.
    const covered = new Set();
    for (const inst of res.body.instances) {
      if (covered.size > 0 && inst.routes.length > 0) {
        expect(inst.routes.some((route) => !covered.has(route))).toBe(true);
      }
      for (const route of inst.routes) covered.add(route);
    }
  });

  it("returns at least one park instance near Union Square itself", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=parks&bucket=park`
    );
    expect(res.status).toBe(200);
    expect(res.body.instances.length).toBeGreaterThanOrEqual(1);
    expect(res.body.instances[0].meters).toBeLessThanOrEqual(800);
  });

  it("caps bus stops at AMENITY_BUS_STOP_CAP physical poles, closest first, near a dense hub", async () => {
    const res = await server.request(
      `/api/amenities/nearby?lat=${UNION_SQ.lat}&lng=${UNION_SQ.lng}&tier=transit&bucket=bus`
    );
    expect(res.status).toBe(200);
    expect(res.body.instances.length).toBeLessThanOrEqual(AMENITY_BUS_STOP_CAP);
    // Union Sq has more distinct bus poles within 800m than the cap.
    expect(res.body.truncated).toBe(true);
    const sortedCopy = [...res.body.instances].sort((a, b) => a.meters - b.meters);
    expect(res.body.instances).toEqual(sortedCopy);
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
