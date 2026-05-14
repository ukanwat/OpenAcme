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
  tryReimportClaudeCode,
} from "@openacme/auth";
import { injectAnthropicCacheControl } from "./openrouter-cache.js";

function resolveDataDir(): string {
  const fromEnv = process.env["OPENACME_DATA_DIR"];
  if (fromEnv && fromEnv.trim()) return fromEnv;
  // Fallback only used if neither CLI nor server set the env var.
  return `${process.env["HOME"] ?? ""}/.openacme`;
}

const DEBUG = process.env["OPENACME_DEBUG"]?.includes("auth")
  || process.env["OPENACME_DEBUG"] === "1";

/**
 * Last-seen OAuth account_id per provider. Logged on change so the user
 * can see when a new login (or a different account) takes effect mid-run.
 */
const lastSeenAccount: Partial<Record<"openai" | "anthropic", string>> = {};

function noteAccount(
  provider: "openai" | "anthropic",
  accountId: string | undefined,
): void {
  const prev = lastSeenAccount[provider];
  const next = accountId ?? "(no-account-id)";
  if (prev === next) return;
  lastSeenAccount[provider] = next;
  if (prev) {
    console.error(
      `[openacme] auth: ${provider} active account changed: ${maskAccount(prev)} → ${maskAccount(next)}`
    );
  } else if (DEBUG) {
    console.error(`[openacme] auth: ${provider} active account ${maskAccount(next)}`);
  }
}

function maskAccount(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

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
 * Per-process latch: set to true the first time an Anthropic request
 * with the 1M-context beta header comes back with "Extra usage required"
 * (the account-level entitlement isn't present). Future requests skip
 * the beta entirely. Resets on daemon restart — re-probe is one
 * transparent retry on the first request.
 */
let anthropic1mDisabled = false;
const ANTHROPIC_NO_1M_ENTITLEMENT_RX =
  /extra usage is required for long context|context_1m|long.?context.*not.*enabled/i;

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
        // OAuth↔API-key swap mid-run can't be honored here because the
        // base URL and request shape differ — that swap takes effect on
        // the next runStream when getModel re-resolves.
        fetch: async (url, init) => {
          const buildHeaders = async (force: boolean): Promise<Headers> => {
            const { token, accountId } = await getOAuthToken(
              "openai",
              dataDir,
              { force }
            );
            noteAccount("openai", accountId);
            const headers = new Headers(
              init?.headers as Record<string, string> | undefined
            );
            headers.set("Authorization", `Bearer ${token}`);
            if (accountId) headers.set("chatgpt-account-id", accountId);
            headers.set("OpenAI-Beta", "responses=experimental");
            return headers;
          };

          const newBody = transformCodexOAuthBody(init?.body);
          const rewritten = init && newBody !== init.body
            ? { ...init, body: newBody as RequestInit["body"] }
            : init;
          if (DEBUG) console.error("[openacme] →", url, rewritten?.body);

          const send = async (force: boolean) =>
            fetch(url as string | URL, {
              ...rewritten,
              headers: await buildHeaders(force),
            });

          let res = await send(false);
          if (res.status === 401) {
            if (DEBUG) console.error("[openacme] openai 401 — forcing token refresh and retrying");
            try {
              res = await send(true);
            } catch (e) {
              if (DEBUG) console.error("[openacme] openai refresh-on-401 failed:", e);
              throw e;
            }
          }
          return res;
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
    // `isOAuth` is re-evaluated per-fetch below so a login/logout that
    // happens mid-run (between two HTTP requests of the same streamText
    // multi-step turn) takes effect on the very next request. The
    // construction-time `apiKey` is just a placeholder — the fetch hook
    // overwrites the auth header from scratch on every call.
    const provider = createAnthropic({
      apiKey: "oauth-placeholder",
      baseURL: config.baseUrl,
      fetch: async (url, init) => {
        // `isOAuth` is recomputed each call (see `shouldUseOAuth`) so a
        // login/logout that happens mid-run picks up on the very next
        // request without restarting streamText.
        const oauthNow = shouldUseOAuth(
          "anthropic",
          config,
          "ANTHROPIC_API_KEY",
          dataDir
        );

        // Captured by `buildHeaders` on each call, read by the 429
        // recovery branch below to compare "what we sent" vs. "what
        // tryReimport now offers." Differs → Claude Code swapped to a
        // new account; retry with the new bearer.
        let lastSentToken: string | undefined;

        const buildHeaders = async (force: boolean): Promise<Headers> => {
          const headers = new Headers(
            init?.headers as Record<string, string> | undefined
          );
          if (oauthNow) {
            const { token, accountId } = await getOAuthToken(
              "anthropic",
              dataDir,
              { force }
            );
            lastSentToken = token;
            noteAccount("anthropic", accountId);
            headers.delete("x-api-key");
            headers.set("Authorization", `Bearer ${token}`);
            headers.set("User-Agent", "claude-cli/2.1.74 (external, cli)");
            headers.set("x-app", "cli");
            const betas = new Set<string>([
              "interleaved-thinking-2025-05-14",
              "claude-code-20250219",
              "oauth-2025-04-20",
            ]);
            if (anthropicSupportsFineGrainedToolStreaming(config.model)) {
              betas.add("fine-grained-tool-streaming-2025-05-14");
            }
            // 1M context: try by default on capable models. If the API
            // rejects it (account lacks the paid entitlement), the
            // fetch wrapper below latches `anthropic1mDisabled` and
            // retries without the beta — and all subsequent requests
            // in this process skip it from the start.
            if (
              !anthropic1mDisabled &&
              anthropicSupports1mContext(config.model)
            ) {
              betas.add("context-1m-2025-08-07");
            }
            const existing = headers.get("anthropic-beta");
            if (existing) for (const b of existing.split(",")) betas.add(b.trim());
            headers.set(
              "anthropic-beta",
              Array.from(betas).filter(Boolean).join(",")
            );
          } else {
            // API-key path. Strip any stale OAuth bearer the SDK may have
            // attached and set x-api-key from the current source so an
            // env-var change between requests is honored.
            headers.delete("Authorization");
            const key = config.apiKey ?? process.env["ANTHROPIC_API_KEY"];
            if (key) headers.set("x-api-key", key);
            else headers.delete("x-api-key");
            if (config.headers) {
              for (const [k, v] of Object.entries(config.headers)) {
                headers.set(k, v);
              }
            }
          }
          return headers;
        };

        let newBody: unknown = init?.body;
        if (oauthNow) {
          newBody = transformAnthropicOAuthBody(newBody);
        }
        if (stripSampling) {
          newBody = stripAnthropicSamplingParams(newBody);
        }
        const rewritten = init && newBody !== init.body
          ? { ...init, body: newBody as RequestInit["body"] }
          : init;
        if (DEBUG) console.error("[openacme] →", url, rewritten?.body);

        const send = async (force: boolean) =>
          fetch(url as string | URL, {
            ...rewritten,
            headers: await buildHeaders(force),
          });

        let res = await send(false);
        // 401 on an OAuth call usually means the token was revoked
        // server-side (account swapped, rotated elsewhere, suspended)
        // before our `expires_at` claim caught up. Force-refresh once
        // and retry — if still 401, propagate so the user sees the
        // login prompt. `getOAuthToken` itself attempts a silent
        // Claude Code re-import on refresh failure (see
        // `@openacme/auth/refresh.ts`), so this branch covers both
        // "stored refresh_token still good" and "user just swapped
        // accounts in Claude Code" without extra work here.
        if (oauthNow && res.status === 401) {
          if (DEBUG) console.error("[openacme] anthropic 401 — forcing token refresh and retrying");
          try {
            res = await send(true);
          } catch (e) {
            if (DEBUG) console.error("[openacme] anthropic refresh-on-401 failed:", e);
            throw e;
          }
        }
        // 429 with OAuth: the account we're using is rate-capped. If
        // the user has since switched to a different Claude account in
        // Claude Code, that account has its own usage budget. Try a
        // one-shot Claude Code re-import; if the active bearer differs
        // from the one we just sent, retry with it. If it doesn't
        // differ, propagate the 429 — there's nothing more we can do.
        if (oauthNow && res.status === 429) {
          const active = tryReimportClaudeCode(dataDir);
          if (active && active !== lastSentToken) {
            if (DEBUG) console.error("[openacme] anthropic 429 — claude-code creds changed, retrying with new bearer");
            res = await send(false);
          }
        }
        // 1M-context fallback: if the API rejects the beta because the
        // account lacks entitlement, latch it off for this process and
        // retry the same request without the beta header. Subsequent
        // requests skip the beta in `buildHeaders` from the start.
        if (
          !res.ok &&
          !anthropic1mDisabled &&
          anthropicSupports1mContext(config.model)
        ) {
          try {
            const body = await res.clone().text();
            if (ANTHROPIC_NO_1M_ENTITLEMENT_RX.test(body)) {
              anthropic1mDisabled = true;
              console.warn(
                "[openacme] Anthropic 1M-context not entitled for this account; falling back to 200k for this and future requests."
              );
              res = await send(false);
            }
          } catch {
            // Body read errors fall through with the original response.
          }
        }
        // OAuth-only: strip the mcp_<PascalCase> prefix from tool names in the
        // response, otherwise the SDK's tool-call dispatcher fails with
        // AI_NoSuchToolError because the local registry holds unprefixed names.
        return oauthNow ? transformAnthropicOAuthResponse(res) : res;
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
    const isClaudeModel =
      config.model.toLowerCase().startsWith("anthropic/") ||
      config.model.toLowerCase().includes("claude");
    const provider = createOpenAICompatible({
      name: "openrouter",
      apiKey: config.apiKey ?? process.env["OPENROUTER_API_KEY"],
      baseURL: config.baseUrl ?? "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://openacme.dev",
        "X-Title": "OpenAcme Agent",
        ...config.headers,
      },
      // Anthropic models routed via OpenRouter accept native `cache_control`
      // on chat-completions content blocks, but the openai-compatible adapter
      // won't translate `providerOptions.anthropic.cacheControl` for us.
      // Inject at the wire level for Claude-family models only.
      ...(isClaudeModel
        ? {
            fetch: async (url, init) => {
              const newBody = injectAnthropicCacheControl(init?.body);
              const rewritten =
                init && newBody !== init.body
                  ? { ...init, body: newBody as RequestInit["body"] }
                  : init;
              return fetch(url as string | URL, rewritten);
            },
          }
        : {}),
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
