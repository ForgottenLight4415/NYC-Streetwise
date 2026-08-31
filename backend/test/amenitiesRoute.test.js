import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { startMongo } from "./helpers/mongoTestServer.js";
import { startTestServer } from "./helpers/testServer.js";
import { getDb } from "../src/providers/mongo.js";
import { AMENITIES_COLLECTION } from "../src/config/constants.js";
import { AMENITY_FILE_PATHS } from "../src/providers/amenities/index.js";

// Mocked so this file never reaches the live Citi Bike GBFS feed — same
// reasoning as showcase.test.js mocking fetchCountsForTier instead of raw
// fetch: the route calls one named function, so that is what gets replaced.
const { bikeShareSpy } = vi.hoisted(() => ({ bikeShareSpy: vi.fn() }));

vi.mock("../src/providers/amenities/bikeShare.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchBikeShareBucket: bikeShareSpy };
});

function fixtureBucket(n) {
  // Offset wraps rather than growing unboundedly, so even a large n (matching
  // the real committed bikeShare count) stays inside the provider's sanity
  // range (NYC + a wide margin) instead of drifting out to sea after ~1,300
  // points at 0.001deg spacing.
  return {
    pts: Array.from({ length: n }, (_, i) => [40.7 + (i % 100) * 0.001, -73.9, -1]).flat(),
    names: [],
    n,
  };
}

let mongo;
let server;
let committedBike;

beforeAll(async () => {
  mongo = await startMongo();
  server = await startTestServer();
  committedBike = JSON.parse(await readFile(AMENITY_FILE_PATHS.bike, "utf8"));
});

afterAll(async () => {
  await server.close();
  await mongo.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(AMENITIES_COLLECTION).deleteMany({});
  bikeShareSpy.mockReset();
  bikeShareSpy.mockResolvedValue(fixtureBucket(committedBike.bikeShare.n)); // same size, avoids the sanity guard
  delete process.env.CRON_SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/refresh-amenities", () => {
  const SECRET = "test-cron-secret";

  it("refuses everyone when CRON_SECRET is unset, rather than defaulting open", async () => {
    const res = await server.request("/api/refresh-amenities");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("refresh_amenities_not_configured");
    expect(bikeShareSpy).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller without touching the GBFS feed", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await server.request("/api/refresh-amenities");
    expect(res.status).toBe(401);
    expect(bikeShareSpy).not.toHaveBeenCalled();
  });

  it("401s a wrong secret", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await server.request("/api/refresh-amenities", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
    expect(bikeShareSpy).not.toHaveBeenCalled();
  });

  it("refreshes bikeShare and preserves the committed bikeLane/protectedLane buckets", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await server.request("/api/refresh-amenities", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);
    expect(res.body.bikeShareStations).toBe(committedBike.bikeShare.n);

    const db = await getDb();
    const doc = await db.collection(AMENITIES_COLLECTION).findOne({ _id: "bike" });
    expect(doc.bikeShare.n).toBe(committedBike.bikeShare.n);
    // The two buckets this route never touches must be byte-for-byte the
    // committed ones, not silently dropped or reset.
    expect(doc.bikeLane).toEqual(committedBike.bikeLane);
    expect(doc.protectedLane).toEqual(committedBike.protectedLane);
  });

  it("refuses to save a bikeShare fetch that looks truncated (the sanity guard)", async () => {
    process.env.CRON_SECRET = SECRET;
    bikeShareSpy.mockResolvedValue(fixtureBucket(1)); // far below 70% of the real count

    const res = await server.request("/api/refresh-amenities", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });

    expect(res.status).toBe(200); // the route itself succeeds...
    expect(res.body.saved).toBe(false); // ...but the write was refused

    const db = await getDb();
    expect(await db.collection(AMENITIES_COLLECTION).findOne({ _id: "bike" })).toBeNull();
  });

  it("leaks nothing about the secret in its refusal", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await server.request("/api/refresh-amenities", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});
