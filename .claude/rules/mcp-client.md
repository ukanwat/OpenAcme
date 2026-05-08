---
paths:
  - "packages/mcp-client/**"
---

# mcp-client

Model Context Protocol client. stdio + HTTP/SSE transports. Discovers a server's tools and registers them into `@openacme/tools`'s registry as `mcp-<server>__<tool>`.

## Tool naming: `mcp-<server>__<tool>`, never strip

Namespacing prevents collisions with built-ins and across servers. The tool registry's shadowing rule **allows** MCP↔MCP overwrite intentionally — that's how server refresh works.

- Don't strip the prefix on display unless the UI separately conveys provenance. The agent loop and storage both rely on the namespaced form.

## `buildSafeEnv()` drops credential-shaped env vars

When spawning stdio MCP servers, the inherited environment is filtered: anything matching credential patterns (AWS_*, OPENAI_*, ANTHROPIC_*, GITHUB_TOKEN, etc.) is **removed** before passing to the child.

- Why: a misbehaving MCP server should not be able to ex-fil host credentials.
- If a server actually needs `AWS_ACCESS_KEY_ID`, pass it explicitly via `MCPServerConfig.env` — those are forwarded as-is (they're declared per-server, not inherited).
- Don't widen the filter to "fix" a server that needs an env var. Fix the config.

## Connect retries: 3 attempts, 1s/2s/4s, **per server**

Independent per server. One server failing does not block the others — the agent comes up with the surviving servers and the failed one is logged.

- Don't change to all-or-nothing — the typical local dev setup has 3+ MCP servers and one being broken (e.g., a borked `npx` cache) shouldn't take down chat.
- Backoff is fixed; tunable timeouts are per-server in config.

## Timeouts: seconds in config, ms in code

`connectTimeoutSeconds` and `timeoutSeconds` are config-side seconds; converted with `* 1000` when calling `setTimeout` (`client.ts:128`, `:277`).

- Don't mix units. Don't introduce a new "milliseconds" config key for parallelism — keep everything seconds-on-disk.

## `sanitizeError()` runs on every error path that crosses a boundary

Error messages from MCP servers may quote stdin/stdout snippets that contain credentials (e.g., a leaky stack trace). `security.ts:sanitizeError` strips them before logs and before client-visible strings.

- New error path that surfaces a server's error message? Route it through `sanitizeError`. Don't `console.error(err.message)` raw.

## Tool description scanning

`scanDescription()` (in `security.ts`) checks tool descriptions for prompt-injection patterns at registration time. Suspicious descriptions are flagged but not blocked — the agent still registers the tool but the operator sees a warning.

- Don't make this fatal — a noisy description on a useful tool would break setups for paranoid heuristics.
- Don't make it silent — a malicious description should surface to the operator.
