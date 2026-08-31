import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AMENITY_TIERS, AMENITY_MAX_METERS } from "../src/config/constants.js";

// getAmenityMetrics calls loadAmenities() exactly once per invocation. The
// spy defaults to the REAL implementation (importOriginal), so most tests run
// against the real committed datasets; the degradation tests below override
// it per-test to simulate a dataset failing to load.

const { loadAmenitiesSpy, actualRef, computeWalkingDistancesSpy, readAmenityDistancesSpy, writeAmenityDistancesSpy } =
  vi.hoisted(() => ({
    loadAmenitiesSpy: vi.fn(),
    actualRef: {}, // filled in by the vi.mock factory below with the REAL loadAmenities
    computeWalkingDistancesSpy: vi.fn(),
    readAmenityDistancesSpy: vi.fn(),
    writeAmenityDistancesSpy: vi.fn(),
  }));

vi.mock("../src/providers/amenities/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  actualRef.loadAmenities = actual.loadAmenities;
  return { ...actual, loadAmenities: loadAmenitiesSpy };
});

vi.mock("../src/providers/googleRoutes.js", () => ({
  computeWalkingDistances: computeWalkingDistancesSpy,
}));

vi.mock("../src/providers/cache.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readAmenityDistances: readAmenityDistancesSpy,
    writeAmenityDistances: writeAmenityDistancesSpy,
  };
});

const { getAmenityMetrics } = await import("../src/services/amenityService.js");
const { resetAmenitiesMemo } = await import("../src/providers/amenities/index.js");

// 123 Ludlow St, dense Lower East Side — used elsewhere in this repo (README
// demo address) as a location expected to be well-served on every axis.
const LUDLOW_ST = { lat: 40.7215, lng: -73.9878 };

const NULL_INDEX = { nearest: () => null, nearestN: () => [], countWithin: () => 0 };
const nullIndexed = (buckets) => Object.fromEntries(buckets.map((b) => [b, NULL_INDEX]));

beforeEach(() => {
  resetAmenitiesMemo();
  loadAmenitiesSpy.mockReset();
  loadAmenitiesSpy.mockImplementation(actualRef.loadAmenities);

  // Defaults reproduce "no API key configured, no Mongo" — the same
  // straight-line-only behaviour the real providers fall back to — so every
  // test that doesn't care about the Google/cache path still gets it for
  // free, exactly as before these mocks existed.
  computeWalkingDistancesSpy.mockReset();
  computeWalkingDistancesSpy.mockImplementation(async (origin, destinations) =>
    destinations.map(() => null)
  );
  readAmenityDistancesSpy.mockReset().mockResolvedValue(null);
  writeAmenityDistancesSpy.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  resetAmenitiesMemo();
});

// getAmenityMetrics only ever loads STATIC-dataset tiers — walkability has
// none (see AMENITY_TIERS.walkability's comment) and is deliberately scored
// by a separate function, getWalkabilityMetrics(), covered in its own test
// file. Filtering it out here keeps this file testing what getAmenityMetrics
// actually owns, rather than asserting it returns non-null for a tier it
// was never meant to load.
const STATIC_AMENITY_TIERS = Object.entries(AMENITY_TIERS).filter(([, def]) => def.dataset);

describe("getAmenityMetrics against the real committed data", () => {
  it("returns every tier and bucket the frozen shape expects", async () => {
    const result = await getAmenityMetrics(LUDLOW_ST.lat, LUDLOW_ST.lng);
    expect(result).not.toBeNull();
    for (const [tierName, { buckets }] of STATIC_AMENITY_TIERS) {
      expect(result[tierName]).not.toBeNull();
      for (const bucket of buckets) {
        const metric = result[tierName][bucket];
        expect(metric).toHaveProperty("meters");
        expect(metric).toHaveProperty("within");
        expect(metric).toHaveProperty("name");
      }
    }
  });

  it("finds a nearby subway station within a plausible distance for a dense LES address", async () => {
    const result = await getAmenityMetrics(LUDLOW_ST.lat, LUDLOW_ST.lng);
    expect(result.transit.subway.meters).not.toBeNull();
    expect(result.transit.subway.meters).toBeLessThan(AMENITY_MAX_METERS);
    expect(typeof result.transit.subway.name).toBe("string");
  });

  it("never reports a distance past AMENITY_MAX_METERS", async () => {
    // The middle of Long Island Sound — nothing on land nearby for most buckets.
    const result = await getAmenityMetrics(40.98, -73.2);
    for (const [tierName, { buckets }] of STATIC_AMENITY_TIERS) {
      for (const bucket of buckets) {
        const meters = result[tierName]?.[bucket]?.meters;
        if (meters !== null && meters !== undefined) {
          expect(meters).toBeLessThanOrEqual(AMENITY_MAX_METERS);
        }
      }
    }
  });
});

describe("getAmenityMetrics degradation", () => {
  it("marks a tier null when its dataset is unavailable, but still returns the others", async () => {
    loadAmenitiesSpy.mockResolvedValue({
      transit: null,
      parks: nullIndexed(AMENITY_TIERS.parks.buckets),
      bike: nullIndexed(AMENITY_TIERS.bike.buckets),
    });

    const result = await getAmenityMetrics(40.72, -73.98);
    expect(result.transit).toBeNull();
    expect(result.parks).not.toBeNull();
    expect(result.bike).not.toBeNull();
  });

  it("returns null overall when every dataset is unavailable", async () => {
    loadAmenitiesSpy.mockResolvedValue({ transit: null, parks: null, bike: null });

    const result = await getAmenityMetrics(40.72, -73.98);
    expect(result).toBeNull();
  });

  it("falls back to null/0 metrics for a bucket missing from an otherwise-loaded tier", async () => {
    loadAmenitiesSpy.mockResolvedValue({
      transit: { subway: NULL_INDEX }, // bus and rail missing entirely
      parks: nullIndexed(AMENITY_TIERS.parks.buckets),
      bike: nullIndexed(AMENITY_TIERS.bike.buckets),
    });

    const result = await getAmenityMetrics(40.72, -73.98);
    expect(result.transit.bus).toEqual({ meters: null, within: 0, name: null, routes: [] });
    expect(result.transit.rail).toEqual({ meters: null, within: 0, name: null });
  });
});

/** A fixed, pre-sorted (nearest-first) candidate list, standing in for a real spatialIndex. */
function fakeIndex(candidates) {
  return {
    nearest: () => candidates[0] ?? null,
    nearestN: (lat, lng, count) => candidates.slice(0, count),
    countWithin: () => candidates.length,
  };
}

describe("getAmenityMetrics walking-distance correction", () => {
  const SUBWAY_CANDIDATES = [
    { meters: 300, name: "Nearest-by-air", lat: 1, lng: 1 },
    { meters: 310, name: "Middle", lat: 2, lng: 2 },
    { meters: 320, name: "Actually-closest-on-foot", lat: 3, lng: 3 },
  ];

  function transitOnlyDatasets(subwayCandidates) {
    return {
      transit: { subway: fakeIndex(subwayCandidates), bus: NULL_INDEX, rail: NULL_INDEX },
      parks: nullIndexed(AMENITY_TIERS.parks.buckets),
      bike: nullIndexed(AMENITY_TIERS.bike.buckets),
    };
  }

  it("serves a cached correction without calling Google again", async () => {
    loadAmenitiesSpy.mockResolvedValue(transitOnlyDatasets(SUBWAY_CANDIDATES));
    readAmenityDistancesSpy.mockResolvedValue({
      transit: { subway: { meters: 111, name: "Cached Station" } },
    });

    const result = await getAmenityMetrics(40.72, -73.98);

    expect(result.transit.subway).toEqual({
      meters: 111,
      within: 3,
      name: "Cached Station",
      routes: [],
    });
    expect(computeWalkingDistancesSpy).not.toHaveBeenCalled();
    expect(writeAmenityDistancesSpy).not.toHaveBeenCalled();
  });

  it("on a cache miss, batches every candidate into one call and keeps whichever comes back shortest — not necessarily the straight-line-nearest", async () => {
    loadAmenitiesSpy.mockResolvedValue(transitOnlyDatasets(SUBWAY_CANDIDATES));
    // Google says the straight-line-FARTHEST of the three is actually the
    // shortest real walk (e.g. the nearer two are across an uncrossable road).
    computeWalkingDistancesSpy.mockResolvedValue([500, 450, 150]);

    const result = await getAmenityMetrics(40.72, -73.98);

    expect(computeWalkingDistancesSpy).toHaveBeenCalledTimes(1);
    const [origin, destinations] = computeWalkingDistancesSpy.mock.calls[0];
    expect(origin).toEqual({ lat: 40.72, lng: -73.98 });
    expect(destinations).toEqual([
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
      { lat: 3, lng: 3 },
    ]);

    expect(result.transit.subway).toEqual({
      meters: 150,
      within: 3,
      name: "Actually-closest-on-foot",
      routes: [],
    });

    expect(writeAmenityDistancesSpy).toHaveBeenCalledTimes(1);
    const [, , cached] = writeAmenityDistancesSpy.mock.calls[0];
    expect(cached).toEqual({ transit: { subway: { meters: 150, name: "Actually-closest-on-foot" } } });
  });

  it("falls back to the straight-line-nearest when Google finds no route for any candidate", async () => {
    loadAmenitiesSpy.mockResolvedValue(transitOnlyDatasets(SUBWAY_CANDIDATES));
    computeWalkingDistancesSpy.mockResolvedValue([null, null, null]);

    const result = await getAmenityMetrics(40.72, -73.98);

    expect(result.transit.subway).toEqual({
      meters: 300,
      within: 3,
      name: "Nearest-by-air",
      routes: [],
    });
    // A totally-empty correction is a transient Google failure, not a fact
    // about the address — caching it would lock the address out of the
    // correction for a full TTL. It must not be written.
    expect(writeAmenityDistancesSpy).not.toHaveBeenCalled();
  });

  it("keeps a partial correction: a bucket Google covered stays corrected even when another bucket in the same call comes back empty", async () => {
    loadAmenitiesSpy.mockResolvedValue({
      transit: {
        subway: fakeIndex([{ meters: 300, name: "Subway", lat: 1, lng: 1 }]),
        bus: fakeIndex([{ meters: 90, name: "Bus stop", lat: 2, lng: 2 }]),
        rail: NULL_INDEX,
      },
      parks: nullIndexed(AMENITY_TIERS.parks.buckets),
      bike: nullIndexed(AMENITY_TIERS.bike.buckets),
    });
    // subway's candidate: no route found; bus's candidate: real distance 95m.
    computeWalkingDistancesSpy.mockResolvedValue([null, 95]);

    const result = await getAmenityMetrics(40.72, -73.98);

    expect(result.transit.subway).toEqual({
      meters: 300,
      within: 1,
      name: "Subway",
      routes: [],
    }); // straight-line fallback
    expect(result.transit.bus).toEqual({
      meters: 95,
      within: 1,
      name: "Bus stop",
      routes: [],
    }); // Google-corrected
    expect(writeAmenityDistancesSpy).toHaveBeenCalledWith(
      40.72,
      -73.98,
      { transit: { bus: { meters: 95, name: "Bus stop" } } }
    );
  });

  it("skips the Google call entirely when there are no straight-line candidates in range", async () => {
    loadAmenitiesSpy.mockResolvedValue({
      transit: nullIndexed(AMENITY_TIERS.transit.buckets),
      parks: nullIndexed(AMENITY_TIERS.parks.buckets),
      bike: nullIndexed(AMENITY_TIERS.bike.buckets),
    });

    const result = await getAmenityMetrics(40.72, -73.98);

    expect(result.transit.subway).toEqual({ meters: null, within: 0, name: null, routes: [] });
    expect(computeWalkingDistancesSpy).not.toHaveBeenCalled();
  });
});
