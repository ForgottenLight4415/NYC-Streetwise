import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { computeWalkingDistances } from "../src/providers/googleRoutes.js";

// No network. `fetch` is stubbed so we can assert on what we send Google and
// on how the function behaves when Google misbehaves — a billed,
// rate-limited third-party call must never be the reason /api/score fails,
// so the failure paths matter as much as the happy path.

const ORIGIN = { lat: 40.7215, lng: -73.9878 };
const DESTINATIONS = [
  { lat: 40.722, lng: -73.988 },
  { lat: 40.723, lng: -73.987 },
  { lat: 40.724, lng: -73.986 },
];

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

describe("computeWalkingDistances", () => {
  it("returns one entry per destination, in order, from distanceMeters on ROUTE_EXISTS", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        { originIndex: 0, destinationIndex: 1, distanceMeters: 250, condition: "ROUTE_EXISTS" },
        { originIndex: 0, destinationIndex: 0, distanceMeters: 120, condition: "ROUTE_EXISTS" },
        { originIndex: 0, destinationIndex: 2, distanceMeters: 400, condition: "ROUTE_EXISTS" },
      ])
    );

    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS);
    // Mapped by destinationIndex, not by response array order.
    expect(result).toEqual([120, 250, 400]);
  });

  it("reports null for a destination Google found no walkable route to", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        { originIndex: 0, destinationIndex: 0, distanceMeters: 120, condition: "ROUTE_EXISTS" },
        { originIndex: 0, destinationIndex: 1, condition: "ROUTE_NOT_FOUND" },
        { originIndex: 0, destinationIndex: 2, distanceMeters: 400, condition: "ROUTE_EXISTS" },
      ])
    );

    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS);
    expect(result).toEqual([120, null, 400]);
  });

  it("sends one batched request covering every destination, walking mode", async () => {
    fetchSpy.mockResolvedValue(jsonResponse([]));
    await computeWalkingDistances(ORIGIN, DESTINATIONS);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("computeRouteMatrix");
    expect(init.headers["X-Goog-Api-Key"]).toBe("test-key");
    expect(init.headers["X-Goog-FieldMask"]).toContain("distanceMeters");

    const body = JSON.parse(init.body);
    expect(body.travelMode).toBe("WALK");
    expect(body.origins).toHaveLength(1);
    expect(body.destinations).toHaveLength(3);
    expect(body.origins[0].waypoint.location.latLng.latitude).toBe(ORIGIN.lat);
  });

  it("returns all-null without calling fetch when no API key is configured", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS);
    expect(result).toEqual([null, null, null]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns [] without calling fetch for an empty destination list", async () => {
    const result = await computeWalkingDistances(ORIGIN, []);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("degrades to all-null, never throws, on a non-2xx response", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "quota exceeded" }, 429));
    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS);
    expect(result).toEqual([null, null, null]);
  });

  it("degrades to all-null, never throws, when fetch itself rejects (network failure or timeout)", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS);
    expect(result).toEqual([null, null, null]);
  });

  it("degrades to all-null on a malformed (non-array) response body", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ not: "an array" }));
    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS);
    expect(result).toEqual([null, null, null]);
  });
});
