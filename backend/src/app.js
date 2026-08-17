import express from "express";
import { healthRouter } from "./routes/health.js";
import { scoreRouter } from "./routes/score.js";
import { complaintsRouter } from "./routes/complaints.js";
import { explanationRouter } from "./routes/explanation.js";
import { BadRequestError } from "./lib/validate.js";

/** Custom response headers the browser must be allowed to read cross-origin. */
const COMPLAINTS_HEADERS = ["X-Complaints-Truncated", "X-Complaints-Limit"];

/**
 * Builds the Express app without starting a listener, so tests and the entry
 * point share exactly one wiring path.
 */
export function createApp() {
  const app = express();
  app.use(express.json());

  // Frontend is served from a different origin during development.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
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
