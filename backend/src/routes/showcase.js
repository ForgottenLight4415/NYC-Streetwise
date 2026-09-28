import { Router } from "express";
import {
  RATE_LIMIT_INTERNAL,
  RATE_LIMIT_READ,
  SHOWCASE_DEFAULT_LIMIT,
  SHOWCASE_MAX_LIMIT,
} from "../config/constants.js";
import {
  validateAddress,
  validateCoords,
  validateLimit,
  validateShowcaseMode,
} from "../lib/validate.js";
import { boroughFor } from "../lib/borough.js";
import { bearerAuthStatus } from "../lib/bearerAuth.js";
import { rateLimit } from "../lib/rateLimit.js";
import { recordLookup } from "../providers/addressDirectory.js";
import {
  buildShowcase,
  showcaseFallback,
  warmShowcase,
} from "../services/showcaseService.js";

export const showcaseRouter = Router();

/**
 * GET /api/showcase?limit=&mode=top|recent|random
 *
 * Named, scored addresses that are ALREADY cached — what the homepage shows
 * instead of the fabricated sample reports it used to. Items carry the same
 * `buildingHealth` / `blockQuality` / `meta` shape as POST /api/score, plus the
 * address text and coordinate, so the frontend needs no second type.
 *
 * Cache-only, and that is a contract, not an implementation detail: it never
 * calls Socrata, so it cannot be slow and cannot 503. An empty or partly-expired
 * cache yields FEWER items, or none — the frontend renders what it gets.
 *
 * Also returns `fallback`: one curated address, picked at random, with no
 * scores. It is what a caller shows when `items` is empty — the homepage's hero
 * card fetches a live score for it rather than showing nothing. Sent every time
 * so the client never has to ask twice.
 *
 * @returns 200 { items: [...], fallback: {...} } — always 200 when the input is
 *   valid, including when nothing is cached.
 */
showcaseRouter.get(
  "/api/showcase",
  rateLimit({ ...RATE_LIMIT_READ, name: "showcase" }),
  async (req, res, next) => {
    try {
      const limit = validateLimit(req.query.limit, {
        fallback: SHOWCASE_DEFAULT_LIMIT,
        max: SHOWCASE_MAX_LIMIT,
      });
      const mode = validateShowcaseMode(req.query.mode);
      // `fallback` rides along unconditionally rather than only when items is
      // empty: it costs one array index, and a caller that has to branch on its
      // presence is a caller that will forget to.
      res.json({
        items: await buildShowcase({ limit, mode }),
        fallback: showcaseFallback(),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/lookups  —  requires `Authorization: Bearer $INTERNAL_API_SECRET`
 * body: { address, lat, lng }
 *
 * Records that an address was looked up, so the homepage can name a cached
 * coordinate later. Nothing else in the system stores address text: /api/score
 * takes a coordinate and answers with `address: null`, and this backend does not
 * geocode — which is exactly why this is a separate endpoint rather than a field
 * on the score request. That contract stays coordinate-only.
 *
 * NOT CALLABLE FROM A BROWSER, and that is the whole security model. This writes
 * the one string the app stores and then shows to other people, so the question
 * "is this a real address?" is settled by WHERE IT CAME FROM rather than by
 * inspecting it. Our Next.js geocode route resolves a Places suggestion the user
 * picked, takes Google's own `formattedAddress` from the response, and forwards
 * it here with this secret. A stranger cannot reach this endpoint at all, and
 * our frontend never sends a string a visitor typed.
 *
 * This replaced a set of shape heuristics — house-number prefixes, TLD patterns,
 * a "must name New York" rule. They worked, but they were a blocklist by another
 * name: each one only stopped the phrasings someone had thought of, and the
 * first version let "BUY CRYPTO AT evil.example" through. Provenance has no such
 * gap. What remains of the validation is hygiene, not judgement: length and
 * control characters (see validateAddress).
 *
 * Stores the address, the rounded coordinate, a lookup counter and timestamps.
 * No caller identity, no session, no IP — there is nothing here that ties a row
 * to a person.
 *
 * 202, not 201: the caller fires this and forgets it, and a directory write that
 * fails must not read as a failed geocode. Answers 202 even when the write was
 * skipped (Mongo unconfigured) — the caller has nothing to do differently.
 */
showcaseRouter.post(
  "/api/lookups",
  // A circuit breaker, not per-user fairness. Every legitimate call now arrives
  // from ONE caller — our frontend server — so a per-IP budget sized for a
  // person would throttle every visitor at once. The secret is what keeps
  // strangers out; this only stops a runaway loop on our own side.
  rateLimit({ ...RATE_LIMIT_INTERNAL, name: "lookups" }),
  async (req, res, next) => {
    const auth = bearerAuthStatus(req, process.env.INTERNAL_API_SECRET);
    if (auth === "not_configured") {
      return res.status(503).json({
        error: "lookups_not_configured",
        details:
          "INTERNAL_API_SECRET is not set on this deployment, so lookups are disabled.",
      });
    }
    if (auth !== "ok") {
      return res.status(401).json({ error: "unauthorized" });
    }

    try {
      const body = req.body ?? {};
      const { lat, lng } = validateCoords(body);
      const address = validateAddress(body.address);

      // Borough is derived here rather than accepted from the caller: one
      // definition, and a caller cannot file an address under the wrong one.
      await recordLookup({ address, borough: boroughFor(address, lat, lng), lat, lng });
      res.sendStatus(202);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/warm  —  requires `Authorization: Bearer $CRON_SECRET`
 *
 * Fetches the curated showcase set from Socrata and caches it, so the homepage
 * has real addresses to show. The ONE showcase path that goes upstream.
 *
 * Hit by the daily Vercel cron in vercel.json, and by hand before a demo. It
 * takes as long as sixteen Socrata calls take — do not put it anywhere near a
 * page load. A cache hit performs no write and therefore does not extend the 24h
 * TTL, so this deliberately re-fetches; that is what keeps the set warm forever
 * on a daily schedule.
 *
 * The ONLY authenticated route here, and the only one that needs to be: every
 * other endpoint is a cheap read over public data, while one call to this one is
 * ~62s of live Socrata queries against our token's rate limit. Public would mean
 * anyone who reads the network tab can hold the URL down.
 *
 * Vercel sends the bearer header on scheduled invocations automatically once
 * CRON_SECRET is set on the project, so the cron needs no code of its own.
 * `npm run warm:showcase` bypasses HTTP entirely and needs no secret.
 */
showcaseRouter.get("/api/warm", async (req, res, next) => {
  const auth = bearerAuthStatus(req, process.env.CRON_SECRET);

  // Fails closed when unconfigured — see bearerAuth.js. 503 rather than 401
  // because there is nothing the CALLER can fix; the deploy is missing a
  // variable. Distinct code so a failing cron says which of the two it hit.
  if (auth === "not_configured") {
    return res.status(503).json({
      error: "warm_not_configured",
      details: "CRON_SECRET is not set on this deployment, so warming is disabled.",
    });
  }
  if (auth !== "ok") {
    // No details: a wrong secret gets told nothing beyond "no".
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    res.json(await warmShowcase());
  } catch (err) {
    next(err);
  }
});
