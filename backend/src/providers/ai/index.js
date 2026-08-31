import { AI_PROVIDERS, DEFAULT_AI_PROVIDER } from "../../config/constants.js";
import { generateExplanation as ollama } from "./ollama.js";
import { generateExplanation as gemini } from "./gemini.js";
import { AIError } from "./shared.js";

// The ONLY place in the codebase allowed to branch on AI_PROVIDER.
// Everything upstream (services/explain.js and above) is provider-agnostic —
// that convention is what makes "local runs Llama, deployed runs Gemini" a
// config difference rather than two code paths that drift apart.

const ADAPTERS = {
  [AI_PROVIDERS.ollama]: ollama,
  [AI_PROVIDERS.gemini]: gemini,
};

/** Read at call time, not import time, so tests and Vercel can set it late. */
export function activeProvider() {
  return (process.env.AI_PROVIDER || DEFAULT_AI_PROVIDER).trim().toLowerCase();
}

/**
 * Returns the adapter's `generateExplanation` for the configured provider.
 *
 * An unknown AI_PROVIDER throws rather than silently defaulting: a typo in a
 * Vercel env var would otherwise mean every explanation is a template and
 * nobody notices until someone asks why the AI feature looks static.
 *
 * @returns {(input: {sections: Array<{label: string, band: string, counts?: object, metrics?: object}>}) => Promise<string>}
 */
export function getAdapter() {
  const provider = activeProvider();
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new AIError(
      `unknown AI_PROVIDER "${provider}" — expected one of: ${Object.keys(ADAPTERS).join(", ")}`,
      { provider }
    );
  }
  return adapter;
}

/**
 * Generates one explanation with the active provider. Throws AIError on any
 * failure; services/explain.js is what turns that into a template fallback.
 */
export function generateExplanation(input) {
  return getAdapter()(input);
}

export { AIError };
