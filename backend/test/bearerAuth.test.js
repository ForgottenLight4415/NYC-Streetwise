import { describe, it, expect, afterEach } from "vitest";
import { bearerAuthStatus } from "../src/lib/bearerAuth.js";

// Pure, no network, no Mongo. The route tests in showcase.test.js prove the
// wiring; this proves the decision.
//
// Two routes depend on it: /api/warm (CRON_SECRET) and /api/lookups
// (INTERNAL_API_SECRET). The secret VALUE is passed in, so this file exercises
// the comparison rather than any one route's policy.

const SECRET = "a-long-random-cron-secret-value";

function req(authorization) {
  return { headers: authorization === undefined ? {} : { authorization } };
}

describe("bearerAuthStatus", () => {
  it("accepts the exact bearer token", () => {
    expect(bearerAuthStatus(req(`Bearer ${SECRET}`), SECRET)).toBe("ok");
  });

  it("rejects a wrong secret", () => {
    expect(bearerAuthStatus(req("Bearer not-the-secret"), SECRET)).toBe("unauthorized");
  });

  it("rejects a secret that is merely a prefix of the real one", () => {
    expect(bearerAuthStatus(req(`Bearer ${SECRET.slice(0, -1)}`), SECRET)).toBe("unauthorized");
  });

  it("rejects a correct secret sent without the Bearer scheme", () => {
    expect(bearerAuthStatus(req(SECRET), SECRET)).toBe("unauthorized");
  });

  it("rejects a missing, empty or malformed header", () => {
    expect(bearerAuthStatus(req(), SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(req(""), SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(req("Bearer "), SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(req("Basic abc"), SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(req("bearer " + SECRET), SECRET)).toBe("unauthorized");
  });

  it("survives a request object with no headers at all", () => {
    expect(bearerAuthStatus({}, SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(undefined, SECRET)).toBe("unauthorized");
  });

  it("FAILS CLOSED when the secret is unset — never open by default", () => {
    // The whole point: a deploy that forgets the variable must not quietly serve
    // an endpoint that costs 62s of Socrata calls, or one that writes text onto
    // the homepage.
    expect(bearerAuthStatus(req(`Bearer ${SECRET}`), undefined)).toBe("not_configured");
    expect(bearerAuthStatus(req(), undefined)).toBe("not_configured");
  });

  it("treats an empty-string secret as unconfigured, not as a valid secret", () => {
    expect(bearerAuthStatus(req("Bearer "), "")).toBe("not_configured");
  });

  it("carries no policy of its own — the caller names the credential", () => {
    // /api/warm and /api/lookups pass different secrets through the same check,
    // so one route's token must never open the other's door.
    const cron = "cron-secret";
    const internal = "internal-secret";
    expect(bearerAuthStatus(req(`Bearer ${cron}`), cron)).toBe("ok");
    expect(bearerAuthStatus(req(`Bearer ${cron}`), internal)).toBe("unauthorized");
    expect(bearerAuthStatus(req(`Bearer ${internal}`), internal)).toBe("ok");
  });

  it("compares secrets of differing lengths without throwing", () => {
    // timingSafeEqual throws on length mismatch; hashing first is what makes a
    // one-character guess and a thousand-character guess cost the same.
    expect(bearerAuthStatus(req("Bearer x"), SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(req(`Bearer ${"x".repeat(5000)}`), SECRET)).toBe("unauthorized");
  });
});
