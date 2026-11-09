import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { searchNearbyPlaces } from "../src/providers/googlePlaces.js";

// No network. `fetch` is stubbed so we can assert on what we send Google and
// on how the function behaves when Google misbehaves — a billed,
// rate-limited third-party call must never be the reason /api/score fails,
// so the failure paths matter as much as the happy path. Mirrors
// googleRoutes.test.js's approach for the same reason.

const ORIGIN = { lat: 40.7215, lng: -73.9878 };
const TYPES = ["grocery_store", "supermarket", "restaurant", "cafe", "school"];

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

let fetchSpy;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GOOGLE_MAPS_API_KEY;
});

describe("searchNearbyPlaces", () => {
  // searchNearbyPlaces normalises a Google Places response into {lat, lng, types, name} objects.
  it("normalises Google's response to {lat, lng, types, name}", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        places: [
          {
            location: { latitude: 40.722, longitude: -73.988 },
            types: ["restaurant", "food"],
            displayName: { text: "Test Diner" },
          },
        ],
      })
    );

    const result = await searchNearbyPlaces(ORIGIN, 800, TYPES);
    expect(result).toEqual([
      { lat: 40.722, lng: -73.988, types: ["restaurant", "food"], name: "Test Diner" },
    ]);
  });

  // searchNearbyPlaces sets name to null when a place has no displayName.
  it("names a place null when Places has no displayName", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        places: [{ location: { latitude: 1, longitude: 2 }, types: ["school"] }],
      })
    );

    const result = await searchNearbyPlaces(ORIGIN, 800, TYPES);
    expect(result[0].name).toBeNull();
  });

  // searchNearbyPlaces skips places that lack a location instead of crashing.
  it("drops a result with no location rather than crashing on it", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        places: [
          { types: ["cafe"], displayName: { text: "No location" } },
          { location: { latitude: 1, longitude: 2 }, types: ["cafe"], displayName: { text: "Has location" } },
        ],
      })
    );

    const result = await searchNearbyPlaces(ORIGIN, 800, TYPES);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Has location");
  });

  // searchNearbyPlaces sends a single request with API key, narrow field mask, all included types, distance ranking and the right circle.
  it("sends one combined request covering every type, ranked by distance", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ places: [] }));
    await searchNearbyPlaces(ORIGIN, 800, TYPES);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("searchNearby");
    expect(init.headers["X-Goog-Api-Key"]).toBe("test-key");
    // Narrow field mask — see the provider's own comment on why this matters
    // for billing tier, not just payload size.
    expect(init.headers["X-Goog-FieldMask"]).toBe("places.location,places.types,places.displayName");

    const body = JSON.parse(init.body);
    expect(body.includedTypes).toEqual(TYPES);
    expect(body.rankPreference).toBe("DISTANCE");
    expect(body.locationRestriction.circle.radius).toBe(800);
    expect(body.locationRestriction.circle.center.latitude).toBe(ORIGIN.lat);
    expect(body.locationRestriction.circle.center.longitude).toBe(ORIGIN.lng);
  });

  // searchNearbyPlaces returns [] without calling fetch when GOOGLE_MAPS_API_KEY is unset.
  it("returns [] without calling fetch when no API key is configured", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const result = await searchNearbyPlaces(ORIGIN, 800, TYPES);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // searchNearbyPlaces returns [] rather than throwing on a non-2xx response (429).
  it("degrades to [], never throws, on a non-2xx response", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "quota exceeded" }, 429));
    const result = await searchNearbyPlaces(ORIGIN, 800, TYPES);
    expect(result).toEqual([]);
  });

  // searchNearbyPlaces returns [] rather than throwing when fetch rejects (network failure or timeout).
  it("degrades to [], never throws, when fetch itself rejects (network failure or timeout)", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    const result = await searchNearbyPlaces(ORIGIN, 800, TYPES);
    expect(result).toEqual([]);
  });

  // searchNearbyPlaces returns [] when the response's places field is not an array.
  it("degrades to [] on a malformed (non-array places) response body", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ places: "not an array" }));
    const result = await searchNearbyPlaces(ORIGIN, 800, TYPES);
    expect(result).toEqual([]);
  });

  // searchNearbyPlaces returns [] when the response has no places field (a genuine zero-result answer).
  it("degrades to [] when the response has no places field at all (a genuine zero-result answer)", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}));
    const result = await searchNearbyPlaces(ORIGIN, 800, TYPES);
    expect(result).toEqual([]);
  });
});
