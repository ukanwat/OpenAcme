---
paths:
  - "packages/auth/**"
---

# auth

OAuth for ChatGPT (OpenAI subscription) and Claude (Anthropic subscription). Tokens in `~/.openacme/auth.json` mode 0600. Provider transforms live here too — they're part of the auth contract, not the LLM client.

## `auth.json` is one file; writes are atomic

Shape: `{ version: 1, openai?: OAuthEntry, anthropic?: OAuthEntry }`. Each entry: `{ mode, access_token, refresh_token?, id_token?, expires_at, account_id?, last_refresh? }`.

- Writes go through `store.ts`: tempfile → `chmod 0600` → `rename`. Never `fs.writeFile` directly — partial writes leave a half-credential on disk.
- Reads are sync (called from llm-provider's OAuth probe). Synchronous read on every model dispatch is intentional — async would force a Promise into the streamText fast path.

## Never log raw tokens

`security.ts` provides masking helpers. Any error or log path that touches a credential string must route through them.

- Sanitize **before** the error reaches user-visible logs, not after — once it's in the log buffer it can be tail'd.
- New error path? `OPENACME_DEBUG` does not exempt you.

## Refresh dedup is a correctness requirement

`getOAuthToken()` (`refresh.ts`) keeps a per-provider in-flight map (`refresh.ts:13`). Concurrent callers all `await` the same refresh promise (`:39-42`).

- Why: refresh tokens **rotate**. Two parallel refreshes race; the second one's "valid" token gets invalidated by the first's rotation, and the user is logged out for no reason.
- Don't bypass with a fresh `refreshOne()` per call. Don't introduce a separate refresh path that doesn't go through the in-flight map.

## `REFRESH_SKEW_SECONDS = 120` — do not tune blindly

`refresh.ts:6`. Treat a token as "needs refresh" if it expires within 120s.

- Lower it → mid-request 401s when the token expires between probe and use.
- Raise it → wasted refresh capacity (provider rate limits) and shorter effective token lifetime.
- Touch only with knowledge of the rotation contract for both providers.

## `OAuthRelogin` is a hard-fail signal — do not retry

Thrown from `refreshOne` (`refresh.ts:35`, `:50`) when the refresh fails permanently (revoked / reuse detected). The thrower has already cleared the entry from `auth.json`.

- The catcher's job: surface "run `openacme login --provider <name>`" to the user. Do not catch-and-retry — the entry is gone.
- The CLI catches at the command boundary. Server: similar pattern; don't bury the error.

## Transforms are part of the provider contract

`transforms-{openai,anthropic}.ts` normalize body & response shape for OAuth-bound API contracts. Wired into the provider factory's custom `fetch` in `@openacme/llm-provider`.

- OpenAI: `transformCodexOAuthBody` reshapes for `/backend-api/codex` (Responses API). ChatGPT account headers added by the factory.
- Anthropic: `transformAnthropicOAuthBody` shapes the body; `transformAnthropicOAuthResponse` strips the `mcp_` prefix from streamed tool ids (subscription tools come back prefixed).
- New OAuth provider: add a transform pair here AND wire into the corresponding `@openacme/llm-provider` factory. Skipping the wire-up makes the provider 400 on day one.

## Login flows: browser-loopback or device-code

`oauth-{openai,anthropic}.ts`. Browser flow uses `loopback.ts` + PKCE (`pkce.ts`). Headless: device-code (`looksHeadless()` in `browser.ts` decides).

- Don't pop a browser when `looksHeadless()` is true — SSH'd users get a hung process.
