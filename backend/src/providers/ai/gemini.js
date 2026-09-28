import {
  GEMINI_ENDPOINT_BASE,
  AI_MODELS,
  AI_TEMPERATURE,
  AI_MAX_OUTPUT_TOKENS,
  AI_TIMEOUT_MS,
  GEMINI_THINKING_BUDGET,
} from "../../config/constants.js";
import { buildOverallSummaryPrompt } from "./prompt.js";
import { AIError, cleanExplanation } from "./shared.js";

// Deployed (Vercel) adapter. Hosted HTTP API, so it works identically in any
// environment including serverless — which is exactly what Ollama cannot do.
//
// MODEL DEPRECATION: gemini-2.5-flash-lite is scheduled to shut down
// 2026-10-16. The model string is NOT hardcoded here — it lives in
// constants.js (AI_MODELS.gemini) and is env-overridable via GEMINI_MODEL.

/**
 * @param {{sections: Array<{label: string, band: string, counts?: object, metrics?: object}>}} input
 * @returns {Promise<string>}
 */
export async function generateExplanation(input) {
  const apiKey = process.env.GEMINI_API_KEY; // read at call time, not import time
  if (!apiKey) {
    throw new AIError("GEMINI_API_KEY is not set", { provider: "gemini" });
  }

  const url = `${GEMINI_ENDPOINT_BASE}/${AI_MODELS.gemini}:generateContent`;

  const requestBody = (withThinkingConfig) => ({
    contents: [{ parts: [{ text: buildOverallSummaryPrompt(input) }] }],
    generationConfig: {
      temperature: AI_TEMPERATURE,
      maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
      // Thinking tokens are billed against maxOutputTokens, and this cap is
      // small. Whether the field is accepted at all is model-dependent — see
      // GEMINI_THINKING_BUDGET in constants.js for the measurements.
      ...(withThinkingConfig && GEMINI_THINKING_BUDGET !== null
        ? { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } }
        : {}),
    },
  });

  const send = (withThinkingConfig) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Header rather than ?key= — a query string ends up in access logs.
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(requestBody(withThinkingConfig)),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS.gemini),
    });

  let res;
  try {
    res = await send(true);

    // Some models reject thinkingConfig outright with a 400
    // (gemini-3.5-flash-lite does). Retry once without it rather than making a
    // model swap a hard failure — this is the field most likely to be wrong
    // after someone changes GEMINI_MODEL.
    if (res.status === 400 && GEMINI_THINKING_BUDGET !== null) {
      res = await send(false);
    }
  } catch (err) {
    throw new AIError(`gemini request failed: ${err.message}`, {
      provider: "gemini",
      cause: err,
    });
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    // 429 is the free-tier cap, and it is the failure most likely to happen
    // mid-demo. It is not retried — the template fallback is the answer.
    throw new AIError(`gemini ${res.status}: ${body}`, {
      provider: "gemini",
      status: res.status,
    });
  }

  const payload = await res.json().catch((err) => {
    throw new AIError(`gemini returned unparseable JSON: ${err.message}`, {
      provider: "gemini",
    });
  });

  const candidate = payload?.candidates?.[0];
  const text = candidate?.content?.parts
    ?.map((part) => part?.text ?? "")
    .join("")
    .trim();

  if (!text) {
    // Distinguish "blocked by a safety filter" from "empty for another reason":
    // the first is a prompt problem worth knowing about, the second is noise.
    const reason =
      payload?.promptFeedback?.blockReason ??
      candidate?.finishReason ??
      "no text in response";

    // The specific failure that wastes an afternoon: a thinking model spent the
    // whole output budget reasoning and returned nothing. Name the fix in the
    // error rather than leaving "MAX_TOKENS" to be interpreted.
    const thoughts = payload?.usageMetadata?.thoughtsTokenCount ?? 0;
    const hint =
      reason === "MAX_TOKENS" && thoughts > 0
        ? ` — ${thoughts} thinking tokens consumed the ${AI_MAX_OUTPUT_TOKENS}-token cap; ` +
          "set GEMINI_THINKING_BUDGET=0 for this model or raise AI_MAX_OUTPUT_TOKENS"
        : "";

    throw new AIError(`gemini returned no usable text (${reason})${hint}`, {
      provider: "gemini",
    });
  }

  return cleanExplanation(text, "gemini");
}
