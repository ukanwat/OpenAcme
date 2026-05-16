import type { Provider } from "./schema.js";

/**
 * Recommended default model per provider — used when a user has credentials
 * for a provider but hasn't explicitly picked a model. Biased toward
 * "balanced" over "most capable" to keep cost in line on a fresh install.
 *
 * `null` for providers where a default doesn't make sense (`custom` needs a
 * baseUrl + a model id the user supplies; we won't pick for them).
 */
export const DEFAULT_MODEL_BY_PROVIDER: Record<Provider, string | null> = {
  openai: "gpt-5.5",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-2.5-flash",
  openrouter: "anthropic/claude-sonnet-4.6",
  ollama: "llama3.3",
  custom: null,
};
