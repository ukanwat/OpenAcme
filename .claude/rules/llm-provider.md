---
paths:
  - "packages/llm-provider/**"
---

# llm-provider

Vercel AI SDK model factory + OAuth-aware dispatch. Each provider is a factory function in `registry.ts`; new providers extend `ProviderSchema` in `@openacme/config` first.

## OAuth resolution: explicit > silent fallback

`shouldUseOAuth` (`registry.ts:52`) decides per-call:

- `config.auth === "oauth"` (`:58`) → OAuth, always.
- Otherwise: missing `apiKey` **and** a non-empty access_token in `auth.json` (`:61`) → silently fall back to OAuth. This is intentional — `openacme login` "just works" without config edits.
- API key present → API key, even if a token also exists. Explicit wins.

`OPENACME_DEBUG=1` (or any non-empty value like `=auth`) drops the pino logger to `debug` level globally — provider request/response details, account-swap notes, and 401/429 retries flow to stderr and Logfire. Filter in Logfire via `otel_scope_name = 'llm-provider'` or `attributes->>'provider' = 'anthropic'`.

## Transforms are correctness, not polish

OAuth body/response transforms live in `@openacme/auth/transforms-{openai,anthropic}.ts`. Wired into the provider factory's custom `fetch` hook.

- Anthropic: `transformAnthropicOAuthBody` reshapes the body; `transformAnthropicOAuthResponse` strips the `mcp_` prefix from streamed tool ids. Skipping either → 400s, or tool-id mismatches that look like "agent loops on the same tool call."
- OpenAI: ChatGPT OAuth talks to `/backend-api/codex` (Responses API), **not** `/v1/chat/completions`. `transformCodexOAuthBody` normalizes the request shape. Headers add `OpenAI-Beta: responses=...` and ChatGPT account ids.
- Anthropic 4.7+ rejects sampling params **even on API-key auth**. They are stripped unconditionally for that family — do not re-add `temperature`/`top_p` "for safety."

## `OPENACME_DATA_DIR` must be set before `getModel()`

The OAuth probe in `shouldUseOAuth` reads `auth.json` synchronously via `readAuthFile(dataDir)`. If env isn't set, it reads the wrong path or no path.

- The CLI sets it at `apps/cli/src/index.ts:115` (immediately after parsing argv). Don't move config-loading earlier; don't drop the env-var write.
- Server entry does the same on startup. New entrypoints must too.

## Per-provider notes

| provider | adapter | OAuth | gotchas |
|---|---|---|---|
| `openai` | `@ai-sdk/openai` | yes | OAuth → `/backend-api/codex`; custom fetch injects bearer + ChatGPT account headers |
| `anthropic` | `@ai-sdk/anthropic` | yes | Body+response transforms; 4.7+ strips sampling; Claude Code beta headers (interleaved-thinking, tool-streaming, oauth, `context-1m` for 4.6+) |
| `google` | `@ai-sdk/google` | no | Standard Gemini |
| `openrouter` | `@ai-sdk/openai-compatible` | no | Default in `ConfigSchema` |
| `ollama` | `@ai-sdk/openai-compatible` | no | Local. No `model-registry.json` entry → `lookupModelMetadata` undefined → reactive 413 only |
| `custom` | `@ai-sdk/openai-compatible` | no | Requires `baseUrl`. No registry entry either |

## Adding a provider

1. Extend `ProviderSchema` in `@openacme/config/schema.ts`.
2. Add a factory in `registry.ts`.
3. If OAuth: add transform pair in `@openacme/auth/transforms-<name>.ts` and wire into the factory's custom fetch.
4. Document headers/body shape next to the factory — the next person debugging a 400 will thank you.
