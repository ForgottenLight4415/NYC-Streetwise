import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { rateLimit, resetRateLimits } from "../src/lib/rateLimit.js";
import { RATE_LIMIT_MAX_KEYS } from "../src/config/constants.js";

// The limiter as a unit. What matters is that it counts per caller, resets on a
// window boundary, cannot itself grow without bound, and never becomes the thing
// that breaks a request it should have allowed.

function fakeReq(ip = "1.2.3.4", headers = {}) {
  return { headers: { ...headers }, socket: { remoteAddress: ip } };
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    set(k, v) {
      res.headers[k] = v;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

/** Drives the middleware once, returning whether it passed the request through. */
function hit(mw, req) {
  const res = fakeRes();
  let passed = false;
  mw(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

beforeEach(resetRateLimits);
afterEach(() => vi.useRealTimers());

describe("rateLimit", () => {
  it("allows exactly `limit` requests, then refuses", () => {
    const mw = rateLimit({ limit: 3, windowMs: 60_000, name: "t" });
    const req = fakeReq();

    expect(hit(mw, req).passed).toBe(true);
    expect(hit(mw, req).passed).toBe(true);
    expect(hit(mw, req).passed).toBe(true);

    const fourth = hit(mw, req);
    expect(fourth.passed).toBe(false);
    expect(fourth.res.statusCode).toBe(429);
    expect(fourth.res.body.error).toBe("rate_limited");
  });

  it("counts each caller separately", () => {
    const mw = rateLimit({ limit: 1, windowMs: 60_000, name: "t" });
    expect(hit(mw, fakeReq("1.1.1.1")).passed).toBe(true);
    // A second caller must not inherit the first one's exhausted budget.
    expect(hit(mw, fakeReq("2.2.2.2")).passed).toBe(true);
    expect(hit(mw, fakeReq("1.1.1.1")).passed).toBe(false);
  });

  it("counts each route namespace separately", () => {
    const a = rateLimit({ limit: 1, windowMs: 60_000, name: "a" });
    const b = rateLimit({ limit: 1, windowMs: 60_000, name: "b" });
    const req = fakeReq();

    expect(hit(a, req).passed).toBe(true);
    // Sharing a caller must not mean sharing a counter — otherwise one cheap
    // endpoint's traffic locks a user out of an unrelated expensive one.
    expect(hit(b, req).passed).toBe(true);
    expect(hit(a, req).passed).toBe(false);
  });

  it("resets when the window rolls over", () => {
    vi.useFakeTimers();
    const mw = rateLimit({ limit: 1, windowMs: 1_000, name: "t" });
    const req = fakeReq();

    expect(hit(mw, req).passed).toBe(true);
    expect(hit(mw, req).passed).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect(hit(mw, req).passed).toBe(true);
  });

  it("prefers platform-set forwarding headers over the client-settable one", () => {
    const mw = rateLimit({ limit: 1, windowMs: 60_000, name: "t" });
    // Vercel sets x-real-ip itself; x-forwarded-for is the spoofable one. A
    // caller varying only the latter must not escape its bucket.
    const a = fakeReq("10.0.0.1", { "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" });
    const b = fakeReq("10.0.0.1", { "x-real-ip": "9.9.9.9", "x-forwarded-for": "2.2.2.2" });

    expect(hit(mw, a).passed).toBe(true);
    expect(hit(mw, b).passed).toBe(false);
  });

  it("takes the client, not the proxy, from a forwarded chain", () => {
    const mw = rateLimit({ limit: 1, windowMs: 60_000, name: "t" });
    const a = fakeReq("10.0.0.1", { "x-forwarded-for": "5.5.5.5, 10.0.0.9" });
    const b = fakeReq("10.0.0.1", { "x-forwarded-for": "5.5.5.5, 10.0.0.8" });

    expect(hit(mw, a).passed).toBe(true);
    expect(hit(mw, b).passed).toBe(false);
  });

  it("publishes the headers a client needs to back off", () => {
    const mw = rateLimit({ limit: 2, windowMs: 60_000, name: "t" });
    const req = fakeReq();

    const first = hit(mw, req);
    expect(first.res.headers["X-RateLimit-Limit"]).toBe("2");
    expect(first.res.headers["X-RateLimit-Remaining"]).toBe("1");

    hit(mw, req);
    const blocked = hit(mw, req);
    expect(blocked.res.headers["X-RateLimit-Remaining"]).toBe("0");
    expect(Number(blocked.res.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("skips the limit entirely when `when` says this request is the cheap kind", () => {
    // How /api/complaints prices its two modes differently behind one path.
    const mw = rateLimit({
      limit: 1,
      windowMs: 60_000,
      name: "t",
      when: (req) => req.query?.complete === "1",
    });

    const cheap = { ...fakeReq(), query: {} };
    expect(hit(mw, cheap).passed).toBe(true);
    expect(hit(mw, cheap).passed).toBe(true);
    expect(hit(mw, cheap).passed).toBe(true);

    const expensive = { ...fakeReq(), query: { complete: "1" } };
    expect(hit(mw, expensive).passed).toBe(true);
    expect(hit(mw, expensive).passed).toBe(false);
  });

  it("does not grow without bound — its own table cannot be the exhaustion", () => {
    // One entry per distinct caller key, uncollected, is unbounded memory driven
    // by anyone able to vary a header.
    const mw = rateLimit({ limit: 5, windowMs: 60_000, name: "t" });
    for (let i = 0; i < RATE_LIMIT_MAX_KEYS + 500; i++) {
      hit(mw, fakeReq(`10.0.${Math.floor(i / 256)}.${i % 256}`));
    }
    expect(globalThis[Symbol.for("nyc-streetwise.rateLimit")].size).toBeLessThanOrEqual(
      RATE_LIMIT_MAX_KEYS + 1
    );
  });

  it("drops expired entries as it goes", () => {
    vi.useFakeTimers();
    const mw = rateLimit({ limit: 5, windowMs: 1_000, name: "t" });
    for (let i = 0; i < 50; i++) hit(mw, fakeReq(`10.1.1.${i}`));
    const store = globalThis[Symbol.for("nyc-streetwise.rateLimit")];
    expect(store.size).toBe(50);

    vi.advanceTimersByTime(1_001);
    hit(mw, fakeReq("10.9.9.9"));
    // The sweep runs when a new window opens, so the stale 50 are gone.
    expect(store.size).toBeLessThan(50);
  });

  it("survives a request with no headers and no socket", () => {
    const mw = rateLimit({ limit: 1, windowMs: 60_000, name: "t" });
    expect(hit(mw, { headers: {} }).passed).toBe(true);
  });
});
