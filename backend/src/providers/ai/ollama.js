import {
  OLLAMA_ENDPOINT,
  AI_MODELS,
  AI_TEMPERATURE,
  AI_MAX_OUTPUT_TOKENS,
  AI_TIMEOUT_MS,
} from "../../config/constants.js";
import { buildOverallSummaryPrompt } from "./prompt.js";
import { AIError, cleanExplanation } from "./shared.js";

// Local-dev adapter. Talks to an Ollama server on localhost.
//
// Cannot run on Vercel — serverless has no persistent local process to talk to.
// That is the whole reason the gemini adapter exists; see providers/ai/index.js.

/**
 * @param {{sections: Array<{label: string, band: string, counts?: object, metrics?: object}>}} input
 * @returns {Promise<string>}
 */
export async function generateExplanation(input) {
  const prompt = buildOverallSummaryPrompt(input);

  let res;
  try {
    res = await fetch(OLLAMA_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: AI_MODELS.ollama,
        prompt,
        // Without this Ollama streams NDJSON chunks and res.json() chokes on
        // the second line.
        stream: false,
        options: {
          temperature: AI_TEMPERATURE,
          num_predict: AI_MAX_OUTPUT_TOKENS,
        },
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS.ollama),
    });
  } catch (err) {
    // Connection refused is the normal case when nobody has started Ollama.
    // Say so plainly — this is the error a teammate will actually hit.
    throw new AIError(`ollama unreachable at ${OLLAMA_ENDPOINT}: ${err.message}`, {
      provider: "ollama",
      cause: err,
    });
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new AIError(`ollama ${res.status}: ${body}`, {
      provider: "ollama",
      status: res.status,
    });
  }

  const payload = await res.json().catch((err) => {
    throw new AIError(`ollama returned unparseable JSON: ${err.message}`, {
      provider: "ollama",
    });
  });

  return cleanExplanation(payload?.response, "ollama");
}
