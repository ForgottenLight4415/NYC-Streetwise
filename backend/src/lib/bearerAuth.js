import { createHash, timingSafeEqual } from "node:crypto";

// Shared-secret checks for the routes that must not be callable by strangers.
//
// Two of them, for two different reasons:
//
//   /api/warm     CRON_SECRET         — costs real money to call: one request is
//                                       sixteen live Socrata queries and ~62s.
//   /api/lookups  INTERNAL_API_SECRET — writes a string this app then SHOWS to
//                                       other people, so the writer must be our
//                                       own frontend and nobody else.
//
// The second one replaced a pile of heuristics. The endpoint used to be public
// and guessed whether a submitted string looked like a real address — a
// blocklist game the defender loses eventually. Now the address never comes from
// a browser at all: the Next.js geocode route takes Google's own formatted
// address and forwards it server-to-server with this secret. Provenance instead
// of pattern-matching.
//
// The header format is Vercel's own cron convention: with CRON_SECRET set in the
// project's environment, Vercel sends `Authorization: Bearer <CRON_SECRET>` on
// every scheduled invocation, with no code needed at the call site. Matching it
// means the deployed cron authenticates itself and nothing else has to change.
//
// Header only, never a query parameter: query strings land in access logs,
// browser history and Referer headers, and a secret that leaks into a log is not
// a secret.

/** @typedef {"ok" | "unauthorized" | "not_configured"} BearerAuthStatus */

const BEARER = "Bearer ";

/**
 * Constant-time equality that does not leak the secret's LENGTH.
 *
 * timingSafeEqual throws on mismatched lengths, so comparing raw values would
 * force an early length check — and that check answers "how long is the secret"
 * for anyone willing to time it. Hashing first makes both sides exactly 32
 * bytes, so every wrong guess costs the same and reveals the same: nothing.
 */
function secretsMatch(presented, expected) {
  const digest = (value) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Whether this request carries the expected bearer secret.
 *
 * Three outcomes rather than a boolean, because "nobody configured a secret" and
 * "you presented the wrong one" call for different answers: the first is an
 * operator problem (503, fix your environment), the second is a caller problem
 * (401).
 *
 * FAILS CLOSED. With the secret unset the endpoint refuses everyone, including
 * our own caller. That is deliberate: the alternative — open when unconfigured —
 * means a deploy that forgets the variable is silently a public endpoint, which
 * is exactly the state this exists to prevent.
 *
 * The secret VALUE is passed in rather than read from a name here, so the caller
 * decides which credential a route requires and this file holds no policy. Read
 * it at request time, not module load, so a redeploy or a test can change it
 * without rebuilding the module graph — same reasoning as MONGODB_URI.
 *
 * @param {{headers: Record<string, string|undefined>}} req
 * @param {string|undefined} expected the secret this route requires
 * @returns {BearerAuthStatus}
 */
export function bearerAuthStatus(req, expected) {
  if (!expected) return "not_configured";

  const header = req?.headers?.authorization ?? "";
  if (!header.startsWith(BEARER)) return "unauthorized";

  const presented = header.slice(BEARER.length);
  if (!presented) return "unauthorized";

  return secretsMatch(presented, expected) ? "ok" : "unauthorized";
}
