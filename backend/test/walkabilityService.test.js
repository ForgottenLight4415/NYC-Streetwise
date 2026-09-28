import { describe, it, expect, beforeEach, vi } from "vitest";
import { AMENITY_TIERS } from "../src/config/constants.js";

const { searchNearbyPlacesSpy, readWalkabilityPlacesSpy, writeWalkabilityPlacesSpy } = vi.hoisted(() => ({
  searchNearbyPlacesSpy: vi.fn(),
  readWalkabilityPlacesSpy: vi.fn(),
  writeWalkabilityPlacesSpy: vi.fn(),
}));

vi.mock("../src/providers/googlePlaces.js", () => ({
  searchNearbyPlaces: searchNearbyPlacesSpy,
}));

vi.mock("../src/providers/cache.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readWalkabilityPlaces: readWalkabilityPlacesSpy,
    writeWalkabilityPlaces: writeWalkabilityPlacesSpy,
  };
});

const { getWalkabilityMetrics } = await import("../src/services/amenityService.js");

const POINT = { lat: 40.7215, lng: -73.9878 };
const { buckets: WALKABILITY_BUCKETS, radiusMeters: WALKABILITY_RADIUS } = AMENITY_TIERS.walkability;

beforeEach(() => {
  searchNearbyPlacesSpy.mockReset().mockResolvedValue([]);
  readWalkabilityPlacesSpy.mockReset().mockResolvedValue(null);
  writeWalkabilityPlacesSpy.mockReset().mockResolvedValue(true);
});

describe("getWalkabilityMetrics", () => {
  it("returns every bucket, all null/0, when Places finds nothing", async () => {
    const result = await getWalkabilityMetrics(POINT.lat, POINT.lng);
    expect(Object.keys(result).sort()).toEqual([...WALKABILITY_BUCKETS].sort());
    for (const bucket of WALKABILITY_BUCKETS) {
      expect(result[bucket]).toEqual({ meters: null, within: 0, name: null });
    }
  });

  it("sorts a place into its bucket by the FIRST type that matches", async () => {
    searchNearbyPlacesSpy.mockResolvedValue([
      { lat: 40.7216, lng: -73.9878, types: ["grocery_store", "point_of_interest"], name: "Corner Grocer" },
      { lat: 40.7215, lng: -73.988, types: ["restaurant", "food"], name: "Test Diner" },
    ]);

    const result = await getWalkabilityMetrics(POINT.lat, POINT.lng);
    expect(result.grocery.name).toBe("Corner Grocer");
    expect(result.restaurant.name).toBe("Test Diner");
    expect(result.cafe).toEqual({ meters: null, within: 0, name: null });
  });

  it("keeps the NEAREST place per bucket and counts every match as `within`", async () => {
    searchNearbyPlacesSpy.mockResolvedValue([
      // Farther cafe first, closer cafe second — nearest must win regardless
      // of input order, since Places' own ranking is not something this
      // function should have to trust blindly. ~500m and ~10m respectively,
      // both inside the 800m walkshed.
      { lat: 40.726, lng: -73.9878, types: ["cafe"], name: "Far Cafe" },
      { lat: 40.7216, lng: -73.9878, types: ["cafe"], name: "Near Cafe" },
    ]);

    const result = await getWalkabilityMetrics(POINT.lat, POINT.lng);
    expect(result.cafe.name).toBe("Near Cafe");
    expect(result.cafe.within).toBe(2);
    expect(result.cafe.meters).toBeGreaterThan(0);
    expect(result.cafe.meters).toBeLessThan(WALKABILITY_RADIUS);
  });

  it("ignores a place with no recognised type", async () => {
    searchNearbyPlacesSpy.mockResolvedValue([
      { lat: 40.7216, lng: -73.9878, types: ["point_of_interest"], name: "Unrecognised" },
    ]);

    const result = await getWalkabilityMetrics(POINT.lat, POINT.lng);
    for (const bucket of WALKABILITY_BUCKETS) {
      expect(result[bucket].within).toBe(0);
    }
  });

  it("drops a place past the walkshed radius even if Places returned it", async () => {
    // Defense in depth: locationRestriction should already cap this, but the
    // function must not trust a third-party API to enforce its own contract.
    const farLat = POINT.lat + 0.02; // ~2.2km — well past the 800m walkshed
    searchNearbyPlacesSpy.mockResolvedValue([
      { lat: farLat, lng: POINT.lng, types: ["school"], name: "Too Far School" },
    ]);

    const result = await getWalkabilityMetrics(POINT.lat, POINT.lng);
    expect(result.school).toEqual({ meters: null, within: 0, name: null });
  });

  it("reads from the cache first and never calls Places on a hit", async () => {
    readWalkabilityPlacesSpy.mockResolvedValue([
      { lat: 40.7216, lng: -73.9878, types: ["school"], name: "Cached School" },
    ]);

    const result = await getWalkabilityMetrics(POINT.lat, POINT.lng);
    expect(result.school.name).toBe("Cached School");
    expect(searchNearbyPlacesSpy).not.toHaveBeenCalled();
    expect(writeWalkabilityPlacesSpy).not.toHaveBeenCalled();
  });

  it("writes whatever Places returns to the cache on a miss, even an empty result", async () => {
    readWalkabilityPlacesSpy.mockResolvedValue(null);
    searchNearbyPlacesSpy.mockResolvedValue([]);

    await getWalkabilityMetrics(POINT.lat, POINT.lng);
    expect(writeWalkabilityPlacesSpy).toHaveBeenCalledWith(POINT.lat, POINT.lng, []);
  });

  describe("cacheOnly", () => {
    it("returns null on a cache miss without ever calling Places", async () => {
      readWalkabilityPlacesSpy.mockResolvedValue(null);

      const result = await getWalkabilityMetrics(POINT.lat, POINT.lng, { cacheOnly: true });
      expect(result).toBeNull();
      expect(searchNearbyPlacesSpy).not.toHaveBeenCalled();
      expect(writeWalkabilityPlacesSpy).not.toHaveBeenCalled();
    });

    it("still serves a cache hit", async () => {
      readWalkabilityPlacesSpy.mockResolvedValue([]);

      const result = await getWalkabilityMetrics(POINT.lat, POINT.lng, { cacheOnly: true });
      expect(result).not.toBeNull();
      for (const bucket of WALKABILITY_BUCKETS) {
        expect(result[bucket]).toEqual({ meters: null, within: 0, name: null });
      }
    });
  });
});
