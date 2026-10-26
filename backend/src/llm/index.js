import { withEvents, withJsonParsing, withRetry, withThrottle } from "./decorators.js";
import { GeminiClient } from "./strategies/geminiClient.js";
import { GroqClient } from "./strategies/groqClient.js";

// Registry of available strategies. Adding a provider = one new file + one line here.
const STRATEGIES = {
  gemini: GeminiClient,
  groq: GroqClient
};

let client = null;

// Returns the active LLM client, chosen by LLM_PROVIDER (default: gemini) and
// decorated with the shared features. Callers depend only on the interface,
// never on a specific provider. Order matters: each retry attempt is throttled,
// one "llm_call" event is published per logical call (not per retry), and
// parsing runs on the final successful reply.
export function getLLM() {
  if (client) return client;
  const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
  const Strategy = STRATEGIES[provider];
  if (!Strategy) {
    throw new Error(`Unknown LLM_PROVIDER "${provider}". Available: ${Object.keys(STRATEGIES).join(", ")}`);
  }

  const base = new Strategy();
  const minIntervalMs = Number(process.env.LLM_MIN_INTERVAL_MS || base.defaultMinIntervalMs);
  client = withJsonParsing(withEvents(withRetry(withThrottle(base, minIntervalMs))));
  return client;
}

export const generateJSON = (prompt, images = []) => getLLM().generateJSON(prompt, images);
export const isLlmConfigured = () => getLLM().isConfigured();
export const getLlmModel = () => getLLM().model;
export { analyzePage } from "./analyzePage.js";
