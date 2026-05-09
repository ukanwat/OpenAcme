import {
  wrapLanguageModel,
  defaultSettingsMiddleware,
  type LanguageModel,
} from "ai";
import type { ModelConfig, Provider } from "@openacme/config";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  getOAuthToken,
  OPENAI_INFERENCE_BASE_URL,
  readAuthFile,
  transformAnthropicOAuthBody,
  transformAnthropicOAuthResponse,
  transformCodexOAuthBody,
} from "@openacme/auth";

function resolveDataDir(): string {
  const fromEnv = process.env["OPENACME_DATA_DIR"];
  if (fromEnv && fromEnv.trim()) return fromEnv;
  // Fallback only used if neither CLI nor server set the env var.
  return `${process.env["HOME"] ?? ""}/.openacme`;
}

const DEBUG = process.env["OPENACME_DEBUG"]?.includes("auth")
  || process.env["OPENACME_DEBUG"] === "1";

/** Models that 400 if temperature/top_p/top_k are set. Mirrors Hermes' list. */
function anthropicForbidsSamplingParams(model: string): boolean {
  return ["4-7", "4.7"].some((s) => model.includes(s));
}

/** Only Opus/Sonnet 4.6+ accept the 1M context beta on subscription auth. */
function anthropicSupports1mContext(model: string): boolean {
  const m = model.toLowerCase();
  if (!m.includes("opus") && !m.includes("sonnet")) return false;
  const ver = m.match(/(opus|sonnet)-(\d+)-(\d+)/);
  if (!ver) return false;
  const major = parseInt(ver[2]!, 10);
  const minor = parseInt(ver[3]!, 10);
  // Date suffixes like 20250514 are model versions, not minor; treat as 4.0
  const effMinor = minor > 99 ? 0 : minor;
  return major > 4 || (major === 4 && effMinor >= 6);
}

/** Opus 4.7 400s on `fine-grained-tool-streaming-2025-05-14`; mirror the SDK's per-model strip. */
function anthropicSupportsFineGrainedToolStreaming(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes("opus") && (m.includes("4-7") || m.includes("4.7"))) return false;
  return true;
}

/**
 * Resolve whether a request should take the OAuth path. Honors the explicit
 * `config.auth === "oauth"` first; otherwise silently falls back to OAuth
 * when no API key is configured AND a token exists in auth.json. This makes
 * `openacme login` "just work" without requiring the agent definition to
 * carry an explicit `auth: oauth` field — which is the common case for
 * agents created via the web UI before it grew an auth-mode picker.
 */
function shouldUseOAuth(
  provider: "openai" | "anthropic",
  config: ModelConfig,
  envVar: string,
  dataDir: string,
): boolean {
  if (config.auth === "oauth") return true;
  if (config.apiKey || process.env[envVar]) return false;
  try {
    return !!readAuthFile(dataDir)[provider]?.access_token;
  } catch {
    return false;
  }
}

/** Strip temperature/top_p/top_k from an Anthropic body (Claude 4.7+ contract). */
function stripAnthropicSamplingParams(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    delete obj["temperature"];
    delete obj["top_p"];
    delete obj["top_k"];
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

/**
 * Provider-specific factory functions.
 * Each returns a Vercel AI SDK LanguageModel instance.
 *
 * Mirrors the Hermes pattern of using raw OpenAI SDK + base_url swapping,
 * but with proper provider-specific packages for better type safety.
 */
const providerFactories: Record<
  Provider,
  (config: ModelConfig) => LanguageModel
> = {
  openai: (config) => {
    const dataDir = resolveDataDir();
    if (shouldUseOAuth("openai", config, "OPENAI_API_KEY", dataDir)) {
      const provider = createOpenAI({
        apiKey: "oauth-placeholder", // overridden by fetch
        baseURL: OPENAI_INFERENCE_BASE_URL,
        // Per-request token injection + refresh + body shape coercion.
        // The ChatGPT backend (chatgpt.com/backend-api/codex) requires
        // `store: false` and rejects the SDK's default `temperature: 0`.
        // See .hermes-ref/agent/codex_responses_adapter.py:670-672.
        fetch: async (url, init) => {
          const { token, accountId } = await getOAuthToken("openai", dataDir);
          const headers = new Headers(init?.headers as Record<string, string> | undefined);
          headers.set("Authorization", `Bearer ${token}`);
          if (accountId) headers.set("chatgpt-account-id", accountId);
          headers.set("OpenAI-Beta", "responses=experimental");
          // Apply the full ChatGPT-backend contract: instructions extraction,
          // store=false, model normalization, sampling-param strip.
          const newBody = transformCodexOAuthBody(init?.body);
          const rewritten = init && newBody !== init.body
            ? { ...init, body: newBody as RequestInit["body"] }
            : init;
          if (DEBUG) console.error("[openacme] →", url, rewritten?.body);
          return fetch(url as string | URL, { ...rewritten, headers });
        },
      });
      // ChatGPT backend speaks the Responses API. `store: false` propagates
      // into the SDK's message converter so it inlines function_call items
      // (not item_reference, which needs server-side persistence Codex lacks).
      return wrapLanguageModel({
        model: provider.responses(config.model),
        middleware: defaultSettingsMiddleware({
          settings: {
            providerOptions: { openai: { store: false } },
          },
        }),
      });
    }
    const provider = createOpenAI({
      apiKey: config.apiKey ?? process.env["OPENAI_API_KEY"],
      baseURL: config.baseUrl,
      headers: config.headers,
    });
    return provider(config.model);
  },

  anthropic: (config) => {
    const stripSampling = anthropicForbidsSamplingParams(config.model);
    const dataDir = resolveDataDir();
    const isOAuth = shouldUseOAuth("anthropic", config, "ANTHROPIC_API_KEY", dataDir);
    const provider = createAnthropic({
      apiKey: isOAuth
        ? "oauth-placeholder"
        : (config.apiKey ?? process.env["ANTHROPIC_API_KEY"]),
      baseURL: config.baseUrl,
      headers: isOAuth ? undefined : config.headers,
      // Single fetch hook handles both OAuth header swap AND model-specific
      // body normalization (Claude 4.7+ rejects sampling params).
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers as Record<string, string> | undefined);
        if (isOAuth) {
          const { token } = await getOAuthToken("anthropic", dataDir);
          headers.delete("x-api-key");
          headers.set("Authorization", `Bearer ${token}`);
          headers.set("User-Agent", "claude-cli/2.1.74 (external, cli)");
          headers.set("x-app", "cli");
          const betas = new Set<string>([
            "interleaved-thinking-2025-05-14",
            "claude-code-20250219",
            "oauth-2025-04-20",
          ]);
          // Opus 4.7 400s on this header — mirror the SDK's per-model strip.
          if (anthropicSupportsFineGrainedToolStreaming(config.model)) {
            betas.add("fine-grained-tool-streaming-2025-05-14");
          }
          // 1M context is gated to Opus/Sonnet 4.6+; Haiku and older models
          // reject it ("long context beta is not yet available").
          if (anthropicSupports1mContext(config.model)) {
            betas.add("context-1m-2025-08-07");
          }
          const existing = headers.get("anthropic-beta");
          if (existing) for (const b of existing.split(",")) betas.add(b.trim());
          headers.set("anthropic-beta", Array.from(betas).filter(Boolean).join(","));
        }
        let newBody: unknown = init?.body;
        if (isOAuth) {
          // Full Claude Code OAuth contract: billing header, identity prefix,
          // tool-name prefixing, orphan repair.
          newBody = transformAnthropicOAuthBody(newBody);
        }
        if (stripSampling) {
          // Claude 4.7+ rejects sampling params even with API-key auth.
          newBody = stripAnthropicSamplingParams(newBody);
        }
        const rewritten = init && newBody !== init.body
          ? { ...init, body: newBody as RequestInit["body"] }
          : init;
        if (DEBUG) console.error("[openacme] →", url, rewritten?.body);
        const res = await fetch(url as string | URL, { ...rewritten, headers });
        // OAuth-only: strip the mcp_<PascalCase> prefix from tool names in the
        // response, otherwise the SDK's tool-call dispatcher fails with
        // AI_NoSuchToolError because the local registry holds unprefixed names.
        return isOAuth ? transformAnthropicOAuthResponse(res) : res;
      },
    });
    return provider(config.model);
  },

  google: (config) => {
    const provider = createGoogleGenerativeAI({
      apiKey: config.apiKey ?? process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
      baseURL: config.baseUrl,
      headers: config.headers,
    });
    return provider(config.model);
  },

  openrouter: (config) => {
    const provider = createOpenAICompatible({
      name: "openrouter",
      apiKey: config.apiKey ?? process.env["OPENROUTER_API_KEY"],
      baseURL: config.baseUrl ?? "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://openacme.dev",
        "X-Title": "OpenAcme Agent",
        ...config.headers,
      },
    });
    return provider(config.model);
  },

  ollama: (config) => {
    const provider = createOpenAICompatible({
      name: "ollama",
      baseURL: config.baseUrl ?? "http://localhost:11434/v1",
      headers: config.headers,
    });
    return provider(config.model);
  },

  custom: (config) => {
    if (!config.baseUrl) {
      throw new Error("Custom provider requires a baseUrl");
    }
    const provider = createOpenAICompatible({
      name: "custom",
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      headers: config.headers,
    });
    return provider(config.model);
  },
};

/**
 * Get a Vercel AI SDK LanguageModel from a ModelConfig.
 * This is the primary entry point for LLM access across the platform.
 */
export function getModel(config: ModelConfig): LanguageModel {
  const factory = providerFactories[config.provider as Provider];
  if (!factory) {
    throw new Error(`Unknown provider: ${config.provider}`);
  }
  return factory(config);
}

/**
 * Provider information for display in UI/CLI.
 */
export interface ProviderInfo {
  id: Provider;
  name: string;
  requiresApiKey: boolean;
  envVar?: string;
  defaultBaseUrl?: string;
  /** Provider supports OAuth subscription login (ChatGPT Plus/Pro, Claude Pro/Max). */
  supportsOAuth?: boolean;
}

/**
 * List all supported providers.
 */
export function listProviders(): ProviderInfo[] {
  return [
    { id: "openai", name: "OpenAI", requiresApiKey: true, envVar: "OPENAI_API_KEY", supportsOAuth: true },
    { id: "anthropic", name: "Anthropic", requiresApiKey: true, envVar: "ANTHROPIC_API_KEY", supportsOAuth: true },
    { id: "google", name: "Google Gemini", requiresApiKey: true, envVar: "GOOGLE_GENERATIVE_AI_API_KEY" },
    { id: "openrouter", name: "OpenRouter", requiresApiKey: true, envVar: "OPENROUTER_API_KEY", defaultBaseUrl: "https://openrouter.ai/api/v1" },
    { id: "ollama", name: "Ollama (Local)", requiresApiKey: false, defaultBaseUrl: "http://localhost:11434/v1" },
    { id: "custom", name: "Custom (OpenAI-compatible)", requiresApiKey: false },
  ];
}
