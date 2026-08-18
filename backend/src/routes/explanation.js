import { Router } from "express";
import { RATE_LIMIT_AI } from "../config/constants.js";
import { rateLimit } from "../lib/rateLimit.js";
import { validateCoords, validateTier } from "../lib/validate.js";
import { buildExplanation, isMockMode } from "../services/scoreService.js";
import { EXPLANATION_SOURCES } from "../config/constants.js";

export const explanationRouter = Router();

/**
 * GET /api/explanation?lat=&lng=&tier=building|block
 *
 * THE SLOW PATH. The frontend calls this only when /api/score came back with
 * `explanationSource: "template"`, then swaps the text in place. Synchronous —
 * the client waits on this one call, no polling. That is a deliberate hackathon
 * simplification, and it is what keeps the AI latency off the score request.
 *
 * Always 200 with a usable explanation. If the AI call fails, the response
 * carries the template text and `explanationSource: "template"` — the frontend
 * simply has nothing to swap, and the user never sees an error.
 */
// The tightest tier: this is the only endpoint that spends money, calling a
// metered AI key. A cached explanation is free to re-serve, so a legitimate
// caller needs this at most twice per address.
explanationRouter.get(
  "/api/explanation",
  rateLimit({ ...RATE_LIMIT_AI, name: "explanation" }),
  async (req, res, next) => {
  try {
    const { lat, lng } = validateCoords(req.query);
    const tier = validateTier(req.query.tier);

    if (isMockMode()) {
      // Mock mode has no adapter to call, but the frontend's swap-in-place flow
      // still needs to be exercisable offline.
      return res.json({
        explanation:
          "Mock explanation: this location is being served from deterministic " +
          "mock data, not live 311 records.",
        explanationSource: EXPLANATION_SOURCES.ai,
        mock: true,
      });
    }

    const { explanation, explanationSource } = await buildExplanation(lat, lng, tier);
    res.json({ explanation, explanationSource });
  } catch (err) {
    next(err);
  }
  }
);
