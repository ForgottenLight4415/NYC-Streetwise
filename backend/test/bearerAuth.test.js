import { describe, it, expect } from "vitest";
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
  // bearerAuthStatus returns "ok" for the exact Bearer token.
  it("accepts the exact bearer token", () => {
    expect(bearerAuthStatus(req(`Bearer ${SECRET}`), SECRET)).toBe("ok");
  });

  // bearerAuthStatus returns "unauthorized" for a wrong secret.
  it("rejects a wrong secret", () => {
    expect(bearerAuthStatus(req("Bearer not-the-secret"), SECRET)).toBe("unauthorized");
  });

  // bearerAuthStatus rejects a token that is only a prefix of the real secret.
  it("rejects a secret that is merely a prefix of the real one", () => {
    expect(bearerAuthStatus(req(`Bearer ${SECRET.slice(0, -1)}`), SECRET)).toBe("unauthorized");
  });

  // bearerAuthStatus rejects the correct secret sent without the "Bearer " scheme.
  it("rejects a correct secret sent without the Bearer scheme", () => {
    expect(bearerAuthStatus(req(SECRET), SECRET)).toBe("unauthorized");
  });

  // bearerAuthStatus rejects missing, empty, wrong-scheme and wrong-case Authorization headers.
  it("rejects a missing, empty or malformed header", () => {
    expect(bearerAuthStatus(req(), SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(req(""), SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(req("Bearer "), SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(req("Basic abc"), SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(req("bearer " + SECRET), SECRET)).toBe("unauthorized");
  });

  // bearerAuthStatus returns "unauthorized" (no throw) when the request has no headers or is undefined.
  it("survives a request object with no headers at all", () => {
    expect(bearerAuthStatus({}, SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(undefined, SECRET)).toBe("unauthorized");
  });

  // bearerAuthStatus returns "not_configured" when the secret is unset, so endpoints fail closed.
  it("FAILS CLOSED when the secret is unset — never open by default", () => {
    // The whole point: a deploy that forgets the variable must not quietly serve
    // an endpoint that costs 62s of Socrata calls, or one that writes text onto
    // the homepage.
    expect(bearerAuthStatus(req(`Bearer ${SECRET}`), undefined)).toBe("not_configured");
    expect(bearerAuthStatus(req(), undefined)).toBe("not_configured");
  });

  // bearerAuthStatus treats an empty-string secret as "not_configured", not as a valid secret.
  it("treats an empty-string secret as unconfigured, not as a valid secret", () => {
    expect(bearerAuthStatus(req("Bearer "), "")).toBe("not_configured");
  });

  // bearerAuthStatus checks against whichever secret the caller passes, so one route's token cannot open another's.
  it("carries no policy of its own — the caller names the credential", () => {
    // /api/warm and /api/lookups pass different secrets through the same check,
    // so one route's token must never open the other's door.
    const cron = "cron-secret";
    const internal = "internal-secret";
    expect(bearerAuthStatus(req(`Bearer ${cron}`), cron)).toBe("ok");
    expect(bearerAuthStatus(req(`Bearer ${cron}`), internal)).toBe("unauthorized");
    expect(bearerAuthStatus(req(`Bearer ${internal}`), internal)).toBe("ok");
  });

  // bearerAuthStatus compares secrets of differing lengths (including 5000 chars) without throwing.
  it("compares secrets of differing lengths without throwing", () => {
    // timingSafeEqual throws on length mismatch; hashing first is what makes a
    // one-character guess and a thousand-character guess cost the same.
    expect(bearerAuthStatus(req("Bearer x"), SECRET)).toBe("unauthorized");
    expect(bearerAuthStatus(req(`Bearer ${"x".repeat(5000)}`), SECRET)).toBe("unauthorized");
  });
});
