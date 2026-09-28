import { RATE_LIMIT_MAX_KEYS } from "../config/constants.js";

// Per-caller request ceilings for the routes that cost something to serve.
//
// What this defends. Every route but /api/warm is deliberately public, and most
// are cheap Mongo reads. But several reach upstream on a miss: /api/score is two
// live Socrata queries, /api/complaints?complete=1 was measured at 2.3-74.3s,
// and /api/explanation spends Gemini quota we pay for. None of that is protected
// by validation, because none of it is invalid — it is ordinary use, repeated.
// A single client looping over coordinates inside the NYC bounding box can
// exhaust the Socrata token, the AI quota, and the M0 tier's 512MB, without ever
// sending a malformed request.
//
// HONEST LIMITS OF THIS. State is in-process memory, so on Vercel each warm
// instance counts separately and the effective ceiling is (instances x limit).
// That is a real weakness and it is still worth having: it caps what one caller
// gets from one instance, it costs nothing, and it cannot itself be the outage.
// The alternative — a shared counter in Mongo — would add a write to every
// request, on the same free-tier cluster we are trying to protect, and would
// make the limiter a dependency of the thing it defends. If this app ever needs
// a hard global ceiling, that belongs at the edge (Vercel WAF / Cloudflare),
// not here.
//
// Fixed windows, not a token bucket: a burst of 60 at the boundary is not a
// threat model this app has, and a fixed window is one integer and one timestamp
// per caller rather than a refill calculation on every request.

/**
 * Buckets live on globalThis, not module scope.
 *
 * Same reasoning as the Mongo client in providers/mongo.js: serverless instance
 * reuse and `node --watch` both rebuild the module registry while keeping the
 * process, and a module-scoped Map would reset the counters every time — which
 * an attacker triggering redeploys could use, and which would make the limiter
 * silently useless in development.
 */
const STORE = Symbol.for("nyc-streetwise.rateLimit");

function store() {
  if (!globalThis[STORE]) globalThis[STORE] = new Map();
  return globalThis[STORE];
}

/** Test seam: forget every counter. */
export function resetRateLimits() {
  globalThis[STORE] = new Map();
}

/**
 * The caller's address, preferring headers the platform itself sets.
 *
 * `x-forwarded-for` is client-supplied unless a proxy overwrites it, so a caller
 * can spoof it to get a fresh bucket per request. Vercel sets `x-real-ip` and
 * `x-vercel-forwarded-for` itself, and those are checked first for that reason.
 * The socket address is the fallback and is the only one that cannot be forged,
 * but behind any proxy it is the proxy.
 *
 * Spoofing is therefore possible in some deployments. That caps what this can
 * promise: it stops casual hammering and accidental loops, not a determined
 * attacker rotating headers. Rejecting the header entirely would be worse — then
 * every request behind the proxy shares one bucket and one user rate-limits
 * everyone.
 */
function callerKey(req) {
  const header =
    req.headers["x-vercel-forwarded-for"] ??
    req.headers["x-real-ip"] ??
    req.headers["x-forwarded-for"];

  if (typeof header === "string" && header.trim()) {
    // "client, proxy1, proxy2" — the client is first.
    return header.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Drops expired entries, and empties the map wholesale if it has grown past the
 * cap.
 *
 * Without this the map is itself an attack: one entry per distinct caller key,
 * never collected, is unbounded memory growth driven by anyone able to vary an
 * IP or spoof a header. Clearing rather than evicting the oldest keeps it to one
 * cheap operation — the cost of a clear is that everyone gets a fresh window,
 * which is the same thing a process restart does.
 */
function prune(buckets, now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size > RATE_LIMIT_MAX_KEYS) buckets.clear();
}

/**
 * Counts one request against a caller's window and publishes the X-RateLimit-*
 * headers. Returns 0 when allowed, else the whole seconds until the window
 * resets. The one place the counting happens, shared by the middleware and by
 * the in-handler guard below.
 */
function consume({ limit, windowMs, name }, req, res) {
  const now = Date.now();
  const buckets = store();
  const key = `${name}:${callerKey(req)}`;

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
    prune(buckets, now);
  }

  bucket.count += 1;

  const remaining = Math.max(0, limit - bucket.count);
  res.set("X-RateLimit-Limit", String(limit));
  res.set("X-RateLimit-Remaining", String(remaining));
  res.set("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count <= limit) return 0;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

/**
 * The 429 response, shared by the middleware and app.js's error handler (for a
 * RateLimitedError thrown by a guard), so both refusals look identical to the
 * client.
 */
export function sendRateLimited(res, retryAfter) {
  res.set("Retry-After", String(retryAfter));
  // 429 with a code the frontend can branch on. `details` says what to do,
  // because unlike a 400 there is nothing to fix in the request itself.
  return res.status(429).json({
    error: "rate_limited",
    details: `Too many requests. Try again in ${retryAfter}s.`,
  });
}

/** Thrown by a rateLimitGuard() that refused; app.js turns it into a 429. */
export class RateLimitedError extends Error {
  constructor(retryAfter) {
    super("rate_limited");
    this.name = "RateLimitedError";
    this.retryAfter = retryAfter;
  }
}

/**
 * Express middleware limiting one caller to `limit` requests per `windowMs`.
 *
 * @param {object} options
 * @param {number} options.limit    requests allowed per window
 * @param {number} options.windowMs window length in ms
 * @param {string} options.name     bucket namespace, so two routes sharing a
 *   caller do not share a counter
 * @param {(req) => boolean} [options.when] apply only when this returns true —
 *   used to price one endpoint's expensive mode differently from its cheap one
 */
export function rateLimit({ limit, windowMs, name, when }) {
  return function rateLimitMiddleware(req, res, next) {
    if (when && !when(req)) return next();
    const retryAfter = consume({ limit, windowMs, name }, req, res);
    if (retryAfter) return sendRateLimited(res, retryAfter);
    next();
  };
}

/**
 * The same limit, charged from INSIDE a handler, for a cost only known partway
 * through a request: the grouped complaint fill is expensive on a cache miss
 * and ~10ms on a hit, and which one it is takes a cache read to find out.
 * Middleware would have to charge every request the miss price. Returns a
 * `(req, res) => void` that throws RateLimitedError when over the limit.
 *
 * On a charge it overwrites any X-RateLimit-* headers a middleware set
 * earlier on the same request; that is intended, since the stricter budget is
 * the one the caller just spent from.
 */
export function rateLimitGuard({ limit, windowMs, name }) {
  return function chargeRateLimit(req, res) {
    const retryAfter = consume({ limit, windowMs, name }, req, res);
    if (retryAfter) throw new RateLimitedError(retryAfter);
  };
}
