import { z } from 'zod';
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
  headers: z.record(z.string(), z.string()).optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * Transport for an MCP server.
 *
 * - `stdio` — local subprocess; selected automatically when `command` is set.
 * - `http`  — Streamable HTTP (MCP spec rev 2025-03-26+).
 * - `sse`   — legacy HTTP+SSE; still supported for backwards-compat.
 *
 * When omitted on a URL-based server we try `http` first and fall back to
 * `sse` on a 404/405 from the POST /mcp endpoint (canonical "speaks SSE
 * only" signal). Set explicitly to skip auto-detect.
 */
export const MCPTransportSchema = z.enum(["http", "sse", "stdio"]);
export type MCPTransport = z.infer<typeof MCPTransportSchema>;

/**
 * MCP server configuration — how to connect to an external MCP server.
 *
 * Same JSON shape Claude Desktop / Cursor / Cline use, so users can
 * paste configs from anywhere. Lives at `<dataDir>/mcp.json` (catalog,
 * inherited by every agent) or per-agent for agent-private servers.
 */
export const MCPServerConfigSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    // Working directory for stdio servers. Most MCP servers take explicit
    // path args, but a few resolve relative paths from cwd (custom user
    // servers, some Python ones). Ignored for url-based transports.
    cwd: z.string().optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().positive().default(120),
    connectTimeout: z.number().positive().default(60),
    allowedTools: z.array(z.string()).optional(),
    // `enabled.default(true)` is load-bearing: every config in the wild
    // predates this field and must keep connecting on upgrade.
    enabled: z.boolean().default(true),
    transport: MCPTransportSchema.optional(),
  })
  // Catches the "neither command nor url" config at validation time
  // instead of at connect time — tighter feedback for both the API and
  // the YAML/JSON loaders.
  .refine((cfg) => Boolean(cfg.command) || Boolean(cfg.url), {
    message: "MCP server must specify either 'command' (stdio) or 'url' (HTTP/SSE)",
  });
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

/**
 * Agent definition — a named agent with its own config.
 */
export const AgentDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: ModelConfigSchema.prefault({}),
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
      "skill_view",
      "web_search",
      "web_extract",
      "execute_code",
      "process",
    ]),
  // Agent-PRIVATE MCP servers — names must not collide with the global
  // catalog at `<dataDir>/mcp.json`. The agent-store enforces this on
  // write; the manager re-checks defensively when assembling the union.
  mcpServers: z.record(z.string(), MCPServerConfigSchema).default({}),
  // Names of global mcp.json servers this agent should NOT receive.
  // Empty (default) = inherit everything.
  mcpDisabled: z.array(z.string()).default([]),
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
 * Compression (Hermes-style): when a turn's `usage.inputTokens` crosses
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
  // Upper bound on Vercel AI SDK agentic steps per turn. Set high so the
  // agent stops when IT decides (no more tool calls), not when we cap it.
  // Still finite as a safety net against pathological tool-call loops.
  maxSteps: z.number().default(1000),
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
  model: ModelConfigSchema.prefault({}),
  server: ServerConfigSchema.prefault({}),
  behavior: AgentBehaviorSchema.prefault({}),
  skills: SkillsConfigSchema.prefault({}),
  web: WebConfigSchema.prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;
