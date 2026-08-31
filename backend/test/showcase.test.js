import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { startMongo } from "./helpers/mongoTestServer.js";
import { startTestServer } from "./helpers/testServer.js";
import { getDb } from "../src/providers/mongo.js";
import { writeCounts } from "../src/providers/cache.js";
import { recordLookup } from "../src/providers/addressDirectory.js";
import { resetRateLimits } from "../src/lib/rateLimit.js";
import {
  ADDRESS_LOOKUPS_COLLECTION,
  CACHE_COLLECTION,
  SHOWCASE_MAX_LIMIT,
} from "../src/config/constants.js";
import { SHOWCASE_ADDRESSES } from "../src/config/showcase.js";

// The homepage's data path, end to end over real HTTP.
//
// Socrata is faked purely so its absence is PROVABLE: the one claim this file
// exists to defend is that /api/showcase never reaches upstream, because the
// homepage renders on its result and an uncached score costs 0.3-2.5s.

const { countsSpy } = vi.hoisted(() => ({ countsSpy: vi.fn() }));

vi.mock("../src/providers/socrata.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchCountsForTier: countsSpy };
});

const { buildShowcase } = await import("../src/services/showcaseService.js");
const { buildCachedScoreReport } = await import("../src/services/scoreService.js");

const PARK = { address: "456 Park Ave, New York, NY 10022", borough: "Manhattan", lat: 40.7614, lng: -73.9707 };
const LUDLOW = { address: "123 Ludlow St, New York, NY 10002", borough: "Manhattan", lat: 40.7202, lng: -73.9877 };

const BUILDING = { heatHotWater: 12, unsanitaryCondition: 3, plumbing: 1 };
const BLOCK = { noise: 1653, parking: 402, streetCondition: 88 };

/** A directory row plus both tiers of counts — one fully renderable address. */
async function seedCached(entry, { now } = {}) {
  await recordLookup(entry, { now });
  await writeCounts(entry.lat, entry.lng, "building", BUILDING);
  await writeCounts(entry.lat, entry.lng, "block", BLOCK);
}

let mongo;
let server;

beforeAll(async () => {
  mongo = await startMongo();
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
  await mongo.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(ADDRESS_LOOKUPS_COLLECTION).deleteMany({});
  await db.collection(CACHE_COLLECTION).deleteMany({});
  countsSpy.mockReset();
  // Limits are per process and this suite hammers one address from one host.
  // Cleared per test so a limiter is never the reason an assertion fails, and
  // so the tests that DO exercise it start from a known count.
  resetRateLimits();
});

describe("buildCachedScoreReport", () => {
  it("returns a full report from cache without calling Socrata", async () => {
    await seedCached(PARK);

    const report = await buildCachedScoreReport(PARK.lat, PARK.lng);

    expect(countsSpy).not.toHaveBeenCalled();
    expect(report.buildingHealth.counts).toEqual(BUILDING);
    expect(report.blockQuality.counts).toEqual(BLOCK);
    expect(report.meta.cache).toEqual({ building: "hit", block: "hit" });
    // Same frozen shape as POST /api/score, so the frontend needs no new type.
    expect(report.address).toBeNull();
    expect(typeof report.buildingHealth.score).toBe("number");
    expect(report.buildingHealth.explanation).not.toBe("");
  });

  it("returns null when only one tier is cached", async () => {
    // Not a weaker answer — a different one. The overall verdict is the worse of
    // the two bands, so a half-scored report would state a verdict we cannot back.
    await writeCounts(PARK.lat, PARK.lng, "building", BUILDING);

    expect(await buildCachedScoreReport(PARK.lat, PARK.lng)).toBeNull();
    expect(countsSpy).not.toHaveBeenCalled();
  });

  it("returns null when nothing is cached, rather than fetching", async () => {
    expect(await buildCachedScoreReport(PARK.lat, PARK.lng)).toBeNull();
    expect(countsSpy).not.toHaveBeenCalled();
  });
});

describe("buildShowcase", () => {
  it("names cached coordinates from the directory", async () => {
    await seedCached(PARK);

    const [item] = await buildShowcase({ limit: 6, mode: "top" });

    expect(item.address).toBe(PARK.address);
    expect(item.borough).toBe("Manhattan");
    expect(item.lat).toBe(40.7614);
    expect(item.lookups).toBe(1);
    expect(item.buildingHealth.counts).toEqual(BUILDING);
  });

  it("skips directory rows whose counts have expired", async () => {
    // The directory has no TTL and the counts cache has a 24h one, so this is
    // the normal steady state, not an edge case.
    await seedCached(PARK);
    await recordLookup(LUDLOW);

    const items = await buildShowcase({ limit: 6, mode: "top" });

    expect(items.map((i) => i.address)).toEqual([PARK.address]);
    expect(countsSpy).not.toHaveBeenCalled();
  });

  it("returns an empty list on a cold cache", async () => {
    expect(await buildShowcase({ limit: 6, mode: "top" })).toEqual([]);
    expect(countsSpy).not.toHaveBeenCalled();
  });

  it("orders by popularity for mode=top and by recency for mode=recent", async () => {
    await seedCached(LUDLOW, { now: new Date("2026-08-10T00:00:00Z") });
    await recordLookup(LUDLOW, { now: new Date("2026-08-11T00:00:00Z") });
    await seedCached(PARK, { now: new Date("2026-08-18T00:00:00Z") });

    const top = await buildShowcase({ limit: 6, mode: "top" });
    expect(top.map((i) => i.address)).toEqual([LUDLOW.address, PARK.address]);

    const recent = await buildShowcase({ limit: 6, mode: "recent" });
    expect(recent.map((i) => i.address)).toEqual([PARK.address, LUDLOW.address]);
  });

  it("honours the limit", async () => {
    await seedCached(PARK);
    await seedCached(LUDLOW);
    expect(await buildShowcase({ limit: 1, mode: "top" })).toHaveLength(1);
  });

  it("mode=random returns only cached addresses", async () => {
    await seedCached(PARK);
    await recordLookup(LUDLOW);

    // Sampling over-fetches deliberately: landing on the expired row must not
    // return nothing while a perfectly good cached address sits unused.
    for (let i = 0; i < 8; i++) {
      const items = await buildShowcase({ limit: 1, mode: "random" });
      expect(items.map((x) => x.address)).toEqual([PARK.address]);
    }
  });
});

describe("GET /api/showcase", () => {
  it("answers 200 with an empty list on a cold cache", async () => {
    const res = await server.request("/api/showcase");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("always carries a curated fallback subject, cold cache or warm", async () => {
    // The homepage's hero card needs SOMETHING to score when items is empty, and
    // it must not keep its own copy of addresses that could drift from the set
    // the backend actually pre-warms.
    const cold = await server.request("/api/showcase");
    expect(SHOWCASE_ADDRESSES.map((a) => a.address)).toContain(cold.body.fallback.address);
    expect(cold.body.fallback).toMatchObject({
      lat: expect.any(Number),
      lng: expect.any(Number),
    });
    expect(cold.body.fallback.borough).toBeTruthy();
    // No scores: the caller decides whether to pay for a live fetch.
    expect(cold.body.fallback.buildingHealth).toBeUndefined();

    await seedCached(PARK);
    const warm = await server.request("/api/showcase");
    expect(warm.body.items.length).toBeGreaterThan(0);
    expect(warm.body.fallback).toBeDefined();
  });

  it("does not pin the fallback to one address", async () => {
    // 456 Park Ave used to be hardcoded as the face of a cold homepage. Every
    // curated entry is equally real and equally pre-warmed, so over enough draws
    // more than one must appear.
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const res = await server.request("/api/showcase");
      seen.add(res.body.fallback.address);
    }
    expect(seen.size).toBeGreaterThan(1);
    for (const address of seen) {
      expect(SHOWCASE_ADDRESSES.map((a) => a.address)).toContain(address);
    }
  });

  it("returns items carrying the score payload plus the address", async () => {
    await seedCached(PARK);

    const res = await server.request("/api/showcase?limit=6&mode=top");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const [item] = res.body.items;
    expect(item).toMatchObject({
      address: PARK.address,
      borough: "Manhattan",
      lat: 40.7614,
      lng: -73.9707,
      curated: false,
    });
    expect(item.buildingHealth.radiusMeters).toBe(25);
    expect(item.blockQuality.radiusMeters).toBe(350);
    expect(item.meta.windowMonths).toBe(24);
    expect(countsSpy).not.toHaveBeenCalled();
  });

  it("rejects an unknown mode", async () => {
    const res = await server.request("/api/showcase?mode=popular");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_mode");
  });

  it("rejects a limit above the cap", async () => {
    const res = await server.request(`/api/showcase?limit=${SHOWCASE_MAX_LIMIT + 1}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_limit");
  });
});

describe("GET /api/warm — the only authenticated route", () => {
  const SECRET = "test-cron-secret";

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("refuses everyone when CRON_SECRET is unset, rather than defaulting open", async () => {
    const res = await server.request("/api/warm");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("warm_not_configured");
    // The claim that matters: no upstream work happened.
    expect(countsSpy).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller without touching Socrata", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await server.request("/api/warm");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    // One unauthorised call must not cost the 16 live queries this endpoint runs.
    expect(countsSpy).not.toHaveBeenCalled();
  });

  it("401s a wrong secret without touching Socrata", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await server.request("/api/warm", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
    expect(countsSpy).not.toHaveBeenCalled();
  });

  it("runs the warm job for the cron's own bearer header", async () => {
    process.env.CRON_SECRET = SECRET;
    countsSpy.mockImplementation((lat, lng, tier) =>
      Promise.resolve({ counts: tier === "building" ? BUILDING : BLOCK })
    );

    const res = await server.request("/api/warm", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.failed).toBe(0);
    expect(res.body.warmed).toBe(SHOWCASE_ADDRESSES.length);
    // Two tiers per curated address, and not one call more.
    expect(countsSpy).toHaveBeenCalledTimes(SHOWCASE_ADDRESSES.length * 2);
    // Scoped to the committed list — never the unbounded lookup directory.
    expect(res.body.results.map((r) => r.address).sort()).toEqual(
      SHOWCASE_ADDRESSES.map((a) => a.address).sort()
    );
  });

  it("leaks nothing about the secret in its refusal", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await server.request("/api/warm", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.details).toBeUndefined();
  });
});

describe("POST /api/lookups — server-to-server only", () => {
  const SECRET = "internal-test-secret";

  beforeEach(() => {
    process.env.INTERNAL_API_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_SECRET;
  });

  const auth = { Authorization: `Bearer ${SECRET}` };

  it("records a lookup and answers 202", async () => {
    const res = await server.request("/api/lookups", {
      method: "POST",
      headers: auth,
      body: { address: "88 Bedford Ave, Brooklyn, NY 11249", lat: 40.7178, lng: -73.9647 },
    });

    expect(res.status).toBe(202);
    const db = await getDb();
    const [doc] = await db.collection(ADDRESS_LOOKUPS_COLLECTION).find({}).toArray();
    expect(doc).toMatchObject({
      address: "88 Bedford Ave, Brooklyn, NY 11249",
      // Derived server-side from the address text, never accepted from the caller.
      borough: "Brooklyn",
      lat: 40.7178,
      lng: -73.9647,
      lookups: 1,
    });
  });

  it("refuses an unauthenticated caller — a browser cannot write here", async () => {
    // The heart of the design: the address shown on the homepage can only come
    // from our own frontend forwarding Google's canonical string. A stranger
    // does not get to submit one, so nothing has to guess whether it is real.
    const res = await server.request("/api/lookups", {
      method: "POST",
      body: { address: "88 Bedford Ave, Brooklyn, NY 11249", lat: 40.7178, lng: -73.9647 },
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    const db = await getDb();
    expect(await db.collection(ADDRESS_LOOKUPS_COLLECTION).countDocuments()).toBe(0);
  });

  it("refuses a wrong secret", async () => {
    const res = await server.request("/api/lookups", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
      body: { address: "88 Bedford Ave, Brooklyn, NY 11249", lat: 40.7178, lng: -73.9647 },
    });
    expect(res.status).toBe(401);
  });

  it("fails closed when INTERNAL_API_SECRET is unset", async () => {
    delete process.env.INTERNAL_API_SECRET;
    const res = await server.request("/api/lookups", {
      method: "POST",
      headers: auth,
      body: { address: "88 Bedford Ave, Brooklyn, NY 11249", lat: 40.7178, lng: -73.9647 },
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("lookups_not_configured");
  });

  it("does not accept /api/warm's secret", async () => {
    // Two credentials, two doors. One leaking must not open the other.
    process.env.CRON_SECRET = "cron-secret";
    const res = await server.request("/api/lookups", {
      method: "POST",
      headers: { Authorization: "Bearer cron-secret" },
      body: { address: "88 Bedford Ave, Brooklyn, NY 11249", lat: 40.7178, lng: -73.9647 },
    });
    expect(res.status).toBe(401);
    delete process.env.CRON_SECRET;
  });

  it("ignores a borough supplied by the caller", async () => {
    await server.request("/api/lookups", {
      method: "POST",
      headers: auth,
      body: { ...PARK, borough: "Staten Island" },
    });

    const db = await getDb();
    const [doc] = await db.collection(ADDRESS_LOOKUPS_COLLECTION).find({}).toArray();
    expect(doc.borough).toBe("Manhattan");
  });

  it("still rejects a missing address and an out-of-NYC coordinate", async () => {
    const missing = await server.request("/api/lookups", {
      method: "POST",
      headers: auth,
      body: { lat: 40.7614, lng: -73.9707 },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("missing_address");

    const outside = await server.request("/api/lookups", {
      method: "POST",
      headers: auth,
      body: { address: "1600 Pennsylvania Ave NW, Washington, DC", lat: 38.8977, lng: -77.0365 },
    });
    expect(outside.status).toBe(400);
    expect(outside.body.error).toBe("out_of_bounds");
  });

  it("keeps the hygiene checks the trusted caller cannot make unnecessary", async () => {
    // Provenance settles "is this a real address". It does not settle "will this
    // string corrupt what it is rendered into", so control and bidi characters
    // are still refused, and the length bound still bounds the document.
    for (const address of ["4\u202e5 Park Ave, New York, NY 10022", "x".repeat(201)]) {
      const res = await server.request("/api/lookups", {
        method: "POST",
        headers: auth,
        body: { address, lat: 40.7178, lng: -73.9647 },
      });
      expect(res.status, address.slice(0, 20)).toBe(400);
      expect(res.body.error).toBe("invalid_address");
    }
  });

  it("does not put the address anywhere near Socrata", async () => {
    await server.request("/api/lookups", { method: "POST", headers: auth, body: PARK });
    expect(countsSpy).not.toHaveBeenCalled();
  });
});
