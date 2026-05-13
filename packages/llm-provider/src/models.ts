import type { Provider } from "@openacme/config";

export interface ModelPreset {
  id: string;
  label: string;
  hint?: string;
}

/**
 * Curated model picks per provider. The setup wizard appends a "Custom…"
 * sentinel at the end so users can type any model ID. IDs were verified
 * against each provider's `/models` endpoint or canonical docs.
 */
export const MODEL_PRESETS: Record<Provider, ModelPreset[]> = {
  openai: [
    // ChatGPT subscription users: only gpt-5.5 and gpt-5.2 are verified to
    // work via the Codex backend. Everything else (mini/pro/codex/-pro/o3)
    // returns "model is not supported when using Codex with a ChatGPT
    // account" on standard ChatGPT Plus plans.
    { id: "gpt-5.5", label: "GPT-5.5", hint: "frontier (recommended)" },
    { id: "gpt-5.2", label: "GPT-5.2", hint: "previous gen, broader availability" },
  ],
  anthropic: [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", hint: "most capable" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "balanced (recommended)" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "fast & cheap" },
  ],
  google: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "deep reasoning" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "balanced (recommended)" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", hint: "cheapest" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", hint: "preview" },
  ],
  openrouter: [
    { id: "anthropic/claude-opus-4.7", label: "Claude Opus 4.7" },
    { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", hint: "recommended" },
    { id: "openai/gpt-5.5", label: "GPT-5.5" },
    { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "deepseek/deepseek-v4-pro", label: "DeepSeek v4 Pro", hint: "open-weight" },
    { id: "qwen/qwen3.6-flash", label: "Qwen 3.6 Flash" },
  ],
  ollama: [
    { id: "llama3.3", label: "Llama 3.3", hint: "general (recommended)" },
    { id: "qwen3", label: "Qwen 3", hint: "general" },
    { id: "qwen2.5-coder", label: "Qwen 2.5 Coder", hint: "coding" },
    { id: "deepseek-r1", label: "DeepSeek R1", hint: "reasoning" },
    { id: "gemma3", label: "Gemma 3", hint: "single GPU" },
    { id: "mistral", label: "Mistral 7B", hint: "small & fast" },
  ],
  custom: [],
};

/** Sentinel value used by the setup wizard to mean "open a free-text prompt". */
export const CUSTOM_MODEL_ID = "__custom__";

/**
 * Recommended default model per provider — used when a user finishes setup
 * for a provider but hasn't explicitly picked a model yet. Picked from the
 * "(recommended)" entry in MODEL_PRESETS, biased toward "balanced" over
 * "most capable" to keep cost in line on a fresh install. The user changes
 * via the web UI's model picker or by editing config.yaml.
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
