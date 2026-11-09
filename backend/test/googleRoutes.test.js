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
  // computeWalkingDistances returns distanceMeters per destination in destination order (by destinationIndex, not response order).
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

  // computeWalkingDistances returns null for a destination whose condition is ROUTE_NOT_FOUND.
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

  // computeWalkingDistances sends one batched computeRouteMatrix request in WALK mode with API key, field mask, one origin and all destinations.
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

  // computeWalkingDistances returns all-null without calling fetch when GOOGLE_MAPS_API_KEY is unset.
  it("returns all-null without calling fetch when no API key is configured", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS);
    expect(result).toEqual([null, null, null]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // computeWalkingDistances returns [] without calling fetch when given no destinations.
  it("returns [] without calling fetch for an empty destination list", async () => {
    const result = await computeWalkingDistances(ORIGIN, []);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // computeWalkingDistances returns all-null rather than throwing on a non-2xx response (429).
  it("degrades to all-null, never throws, on a non-2xx response", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "quota exceeded" }, 429));
    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS);
    expect(result).toEqual([null, null, null]);
  });

  // computeWalkingDistances returns all-null rather than throwing when fetch rejects.
  it("degrades to all-null, never throws, when fetch itself rejects (network failure or timeout)", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS);
    expect(result).toEqual([null, null, null]);
  });

  // computeWalkingDistances returns all-null when the response body is not an array.
  it("degrades to all-null on a malformed (non-array) response body", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ not: "an array" }));
    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS);
    expect(result).toEqual([null, null, null]);
  });

  // computeWalkingDistances makes a single attempt by default, with no retry after a 429.
  it("does not retry by default — one 429 degrades to all-null on the first attempt", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "quota exceeded" }, 429));
    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS);
    expect(result).toEqual([null, null, null]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // computeWalkingDistances retries a 429 when retries is set and returns the distances from the successful retry.
  it("retries on 429 when retries is set, and succeeds once the quota clears", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ error: "quota exceeded" }, 429))
      .mockResolvedValueOnce(
        jsonResponse([{ originIndex: 0, destinationIndex: 0, distanceMeters: 120, condition: "ROUTE_EXISTS" }])
      );

    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS, { retries: 3 });
    expect(result).toEqual([120, null, null]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // computeWalkingDistances gives up after the initial attempt plus N retries on repeated 429s and returns all-null.
  it("degrades to all-null after exhausting retries on repeated 429s", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "quota exceeded" }, 429));
    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS, { retries: 2 });
    expect(result).toEqual([null, null, null]);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  // computeWalkingDistances does not retry a non-retryable 4xx (400) even when retries is set.
  it("does not retry a non-retryable 4xx even when retries is set", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "bad request" }, 400));
    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS, { retries: 3 });
    expect(result).toEqual([null, null, null]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // computeWalkingDistances retries after a rejected fetch (network failure or timeout) when retries is set.
  it("retries when fetch itself rejects (network failure or timeout)", async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(
        jsonResponse([{ originIndex: 0, destinationIndex: 0, distanceMeters: 120, condition: "ROUTE_EXISTS" }])
      );

    const result = await computeWalkingDistances(ORIGIN, DESTINATIONS, { retries: 1 });
    expect(result).toEqual([120, null, null]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
