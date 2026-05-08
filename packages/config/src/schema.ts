import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Supported LLM provider identifiers — single source of truth.
 *
 * `PROVIDERS` is exported as a const tuple so consumers (Zod, the
 * `refresh-models` script, future provider-aware code) can derive both
 * the runtime list and the literal-narrowed `Provider` type from it.
 *
 * `REGISTRY_PROVIDERS` is the subset that has entries in the bundled
 * `model-registry.json` (data fetched from models.dev). Two providers
 * are intentionally absent:
 *   - `custom` — "bring-your-own base URL", not a real models.dev key.
 *     A user routing custom to an OpenAI-compatible Azure endpoint with
 *     `model: "gpt-4o"` still resolves via the suffix-match path inside
 *     `lookupModelMetadata` (matches `openai/gpt-4o`).
 *   - `ollama` — models.dev keys by API endpoint provider. Ollama is a
 *     local runtime; the same downloaded weight (llama3.1, qwen2.5,
 *     deepseek-r1, …) runs on Ollama, vLLM, LM Studio, llama.cpp, etc.
 *     and isn't owned by any single provider in the registry. Ollama
 *     users get `{}` from `lookupModelMetadata` and should set absolute
 *     `compressionThresholdTokens` in their behavior config; reactive
 *     413 / context_overflow recovery works regardless.
 *
 * The `refresh-models` script imports `REGISTRY_PROVIDERS` to filter the
 * upstream dump — keeping the enum and filter in sync at build time.
 */
export const PROVIDERS = [
  "openai",
  "anthropic",
  "openrouter",
  "google",
  "ollama",
  "custom",
] as const;
export type Provider = (typeof PROVIDERS)[number];
export const ProviderSchema = z.enum(PROVIDERS);

export const REGISTRY_PROVIDERS = [
  "openai",
  "anthropic",
  "openrouter",
  "google",
] as const satisfies readonly Provider[];

/**
 * Authentication mode for a model: API key (default) or OAuth subscription.
 * OAuth tokens live in `~/.openacme/auth.json` — see `@openacme/auth`.
 */
export const AuthModeSchema = z.enum(["api_key", "oauth"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

/**
 * Model configuration — which provider and model to use.
 */
export const ModelConfigSchema = z.object({
  provider: ProviderSchema.default("openrouter"),
  model: z.string().default("anthropic/claude-sonnet-4-20250514"),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  auth: AuthModeSchema.default("api_key"),
  headers: z.record(z.string()).optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * MCP server configuration — how to connect to an external MCP server.
 */
export const MCPServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  timeout: z.number().default(120),
  connectTimeout: z.number().default(60),
  allowedTools: z.array(z.string()).optional(),
});
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

/**
 * Agent definition — a named agent with its own config.
 */
export const AgentDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: ModelConfigSchema.default({}),
  persona: z.string().default("You are a helpful AI assistant."),
  tools: z
    .array(z.string())
    .default([
      "shell",
      "read_file",
      "write_file",
      "edit",
      "apply_patch",
      "list_files",
      "search_files",
      "session_search",
      "web_search",
      "web_extract",
      "execute_code",
      "process",
    ]),
  mcpServers: z.record(MCPServerConfigSchema).default({}),
  skills: z.array(z.string()).default([]),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/**
 * Server configuration.
 */
export const ServerConfigSchema = z.object({
  port: z.number().default(3210),
  host: z.string().default("127.0.0.1"),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Per-model metadata. Vercel AI SDK's `LanguageModelV1`/`V2` doesn't
 * expose any of these — we look them up here.
 *
 * Source of truth: `data/model-registry.json` in this package,
 * a bundled snapshot of https://models.dev/api.json (community-maintained,
 * AI SDK-aligned). Refresh on demand via
 * `pnpm --filter @openacme/config refresh-models`.
 *
 * The JSON lives outside `src/` so `tsc --build` doesn't have to copy it
 * into `dist/` — we resolve the path relative to `import.meta.url` and
 * `readFileSync` at module load time.
 *
 * All fields optional — refresh script populates whatever models.dev
 * exposes for that model. Consumers (compression, future cost display,
 * future modality routing) read defensively.
 */
export const ModelMetadataSchema = z.object({
  /** Max input tokens. Source: `limit.context`. */
  contextWindow: z.number().optional(),
  /** Max output tokens per call. Source: `limit.output`. */
  maxOutputTokens: z.number().optional(),
  /** USD per million input tokens. Source: `cost.input`. */
  inputCostPerMTok: z.number().optional(),
  /** USD per million output tokens. Source: `cost.output`. */
  outputCostPerMTok: z.number().optional(),
  /** Allowed input modalities — e.g. ["text", "image", "pdf"]. */
  inputModalities: z.array(z.string()).optional(),
  /** Allowed output modalities — e.g. ["text"]. */
  outputModalities: z.array(z.string()).optional(),
  /** Model accepts file attachments. */
  supportsAttachment: z.boolean().optional(),
  /** Model emits interleaved reasoning blocks (Anthropic style). */
  supportsReasoning: z.boolean().optional(),
  /** Model supports OpenAI-style tool calls. */
  supportsToolCall: z.boolean().optional(),
  /** Model honors `temperature` (some Kimi/o1-class models ignore it). */
  supportsTemperature: z.boolean().optional(),
  /** Family/series id — e.g. "claude-opus", "gpt-4". */
  family: z.string().optional(),
  /** Knowledge cutoff date (ISO yyyy-mm-dd). */
  knowledgeCutoff: z.string().optional(),
  /** Whether weights are open. */
  openWeights: z.boolean().optional(),
});
export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;

// Resolve `data/model-registry.json` relative to this module so it
// works in dev (`src/schema.ts` → `../data/...`) and after build
// (`dist/schema.js` → `../data/...`). The `data/` dir is shipped via the
// `files` array in package.json, so npm consumers see it too.
const REGISTRY: Record<string, ModelMetadata> = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataPath = join(here, "..", "data", "model-registry.json");
  return JSON.parse(readFileSync(dataPath, "utf-8")) as Record<
    string,
    ModelMetadata
  >;
})();

/**
 * Resolve metadata for a given model config. Looks up the bundled
 * snapshot, in order:
 *
 *   1. `${provider}/${model.model}` — canonical key in the snapshot.
 *   2. Suffix match on the bare model id — registry keys are
 *      `provider/modelId`; we match a config like
 *      `{ provider: "custom", model: "gpt-4o" }` against `openai/gpt-4o`.
 *      Useful for the `custom` provider routing to OpenAI-compatible
 *      endpoints (Azure OpenAI, vLLM with same model name, etc.).
 *   3. Prefix match — handles versioned ids like
 *      `claude-opus-4-7-20251201` matching `anthropic/claude-opus-4-7`.
 *      Only matches when the registry key is followed by `-` in the
 *      resolved id, so `claude-3` doesn't accidentally match
 *      `claude-3-5-sonnet`.
 *   4. Fallback: `{}`.
 *
 * Synchronous: the registry JSON is loaded once at module init.
 */
export function lookupModelMetadata(model: ModelConfig): ModelMetadata {
  const qualified = `${model.provider}/${model.model}`;
  const direct = REGISTRY[qualified];
  if (direct) return direct;
  const bareSuffix = `/${model.model}`;
  for (const [k, v] of Object.entries(REGISTRY)) {
    // Exact suffix match: `openai/gpt-4o` ends with `/gpt-4o`.
    if (k.endsWith(bareSuffix)) return v;
  }
  for (const [k, v] of Object.entries(REGISTRY)) {
    // Versioned-id prefix match: `anthropic/claude-opus-4-7` is a prefix
    // of `anthropic/claude-opus-4-7-20251201`.
    if (qualified.startsWith(k + "-")) return v;
  }
  return {};
}

/**
 * Agent behavior configuration.
 *
 * Compression (Hermes-style): when a turn's `usage.promptTokens` crosses
 * the threshold, the agent forks the session synchronously at end-of-turn.
 * The fork:
 *   1. Pre-prunes old tool results (dedup, 1-line summaries, JSON arg trim)
 *   2. Cuts the head/tail boundary by token budget, anchored to the most
 *      recent user message so a tool-call/result pair never splits
 *   3. Summarizes the older portion via auxiliary model (or main model on
 *      aux-model failure), with iterative UPDATE prompts on subsequent
 *      compressions
 *   4. Builds a new child session with [pre-pruned head, summary, pre-pruned tail]
 *
 * Trigger: set `compressionThresholdTokens` for an absolute threshold, OR
 * `compressionThresholdPercent` (in which case the resolved context window
 * comes from `modelRegistry[model].contextWindow`). When both are set,
 * the absolute wins. Both null disables proactive compression; reactive
 * compression on provider 413 / context_overflow errors still fires.
 */
export const AgentBehaviorSchema = z.object({
  maxSteps: z.number().default(10),
  maxIterations: z.number().default(90),
  // Trigger. Default `compressionThresholdPercent: 0.5` enables proactive
  // compression at half the model's context window for any model present
  // in the bundled registry. Models without a registry entry fall through
  // silently — set `compressionThresholdTokens` to opt those in absolutely.
  compressionThresholdTokens: z.number().nullable().default(null),
  compressionThresholdPercent: z.number().nullable().default(0.5),
  // Boundary
  compressionProtectFirstN: z.number().default(3),
  compressionTailTokenBudget: z.number().default(20000),
  // Summarizer. The 0.10–0.80 clamp guards against accidentally requesting
  // a 5%-ratio summary (loses everything) or 95% (defeats compression).
  compressionSummaryTargetRatio: z.number().min(0.1).max(0.8).default(0.2),
  compressionSummarizerInputCharBudget: z.number().default(80000),
  compressionSummarizerModel: ModelConfigSchema.optional(),
});
export type AgentBehavior = z.infer<typeof AgentBehaviorSchema>;

/**
 * Skills configuration.
 */
export const SkillsConfigSchema = z.object({
  directory: z.string().default("skills"),
  autoGenerate: z.boolean().default(false),
});
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

/**
 * Web tools configuration — search provider + key resolution.
 * If `searchApiKey` is unset the agent reads from env vars at call-time
 * (OPENACME_SEARCH_API_KEY, then TAVILY_API_KEY / EXA_API_KEY / BRAVE_API_KEY).
 */
export const WebConfigSchema = z.object({
  searchProvider: z.enum(["tavily", "exa", "brave"]).default("tavily"),
  searchApiKey: z.string().optional(),
});
export type WebConfig = z.infer<typeof WebConfigSchema>;

/**
 * Root configuration schema — maps to config.yaml
 *
 * Agents are not stored here. They live as folders under
 * `<dataDir>/agents/<id>/AGENT.md`, one folder per agent. Any `agents:`
 * key in older configs is silently ignored by Zod's default object stripping.
 */
export const ConfigSchema = z.object({
  dataDir: z.string().default("~/.openacme"),
  model: ModelConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
  behavior: AgentBehaviorSchema.default({}),
  skills: SkillsConfigSchema.default({}),
  web: WebConfigSchema.default({}),
});
export type Config = z.infer<typeof ConfigSchema>;
