import express from "express";
import { healthRouter } from "./routes/health.js";
import { scoreRouter } from "./routes/score.js";
import { complaintsRouter } from "./routes/complaints.js";
import { explanationRouter } from "./routes/explanation.js";
import { trendRouter } from "./routes/trend.js";
import { BadRequestError } from "./lib/validate.js";

/** Custom response headers the browser must be allowed to read cross-origin. */
const COMPLAINTS_HEADERS = [
  "X-Complaints-Truncated",
  "X-Complaints-Limit",
  "X-Complaints-Total",
  "X-Complaints-Offset",
  "X-Complaints-Has-More",
  "X-Complaints-Cached",
];

// Comma-separated list of origins allowed to read responses from a browser.
// Read at request time (not module load) so it can be set after the module
// graph is built, same reasoning as MONGODB_URI in providers/mongo.js.
// Defaults to the frontend's local dev origin so `npm run dev` on both sides
// works with zero config; the deployed frontend's Vercel URL must be set here
// explicitly via ALLOWED_ORIGIN, or its browser calls will be blocked from
// reading the response (the request still completes — this is a read-only
// public API, not auth — only the browser's JS is denied the body).
const DEFAULT_ALLOWED_ORIGIN = "http://localhost:3000";

function getAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGIN;
  if (!raw) return [DEFAULT_ALLOWED_ORIGIN];
  return raw.split(",").map((origin) => origin.trim()).filter(Boolean);
}

/**
 * Builds the Express app without starting a listener, so tests and the entry
 * point share exactly one wiring path.
 */
export function createApp() {
  const app = express();
  app.use(express.json());

  // Frontend is served from a different origin than this API, in both dev and
  // prod. Reflect the request's Origin back only when it is on the allowlist,
  // rather than "*", so only our own deployed frontend (or local dev) can read
  // responses from a browser.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && getAllowedOrigins().includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    // Without this, browser JS cannot READ our custom headers even though they
    // arrive — /api/complaints reports its truncation there, and the frontend
    // would silently see `undefined` instead.
    res.set("Access-Control-Expose-Headers", COMPLAINTS_HEADERS.join(","));
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Every route is public — this is a read-only view over NYC Open Data, and
  // there is nothing here that belongs to any one caller.
  app.use(healthRouter);
  app.use(scoreRouter);
  app.use(complaintsRouter);
  app.use(explanationRouter);
  app.use(trendRouter);

  app.use((req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Central error handler. Routes throw BadRequestError (400) via the shared
  // validator; anything else is a 500 with no internals leaked.
  app.use((err, req, res, next) => {
    // Dispatch on error TYPE, never on `err.status` alone. SocrataError also
    // carries a `status`, but it is the UPSTREAM's status, not ours — a generic
    // "4xx means client error" branch here would forward Socrata's 400 body
    // (query text and all) to the browser as if we had rejected the request.
    // Hence: SocrataError first, and our own errors matched by class.

    // The upstream being down is not our bug, and a 500 tells the frontend
    // nothing it can act on. 503 + a distinct code lets it say "NYC's data
    // service is unavailable, try again" instead of "something broke".
    if (err?.name === "SocrataError") {
      console.error("[upstream]", err.message);
      return res.status(503).json({
        error: "upstream_unavailable",
        details: "NYC Open Data is not responding; try again shortly.",
      });
    }

    // Ours: BadRequestError (400) from the validator. It already carries a safe
    // machine-readable code as `message` and prose in `details`, neither
    // derived from an internal exception, so forwarding both leaks nothing.
    if (err instanceof BadRequestError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    console.error("[error]", err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
