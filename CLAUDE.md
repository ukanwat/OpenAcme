# OpenAcme — Claude Code guide

TypeScript agent platform. Multi-provider LLM with streaming tool-calls, SQLite-backed sessions, MCP integration, OAuth (ChatGPT / Claude subscriptions), an Ink-based CLI TUI, and a Next.js web UI served by the Hono server.

---

## Workspace layout

Turborepo + pnpm 9. Workspace globs: `apps/*`, `packages/*`. Published packages are `@openacme/*`; internal tooling is `@repo/*`.

```
apps/
  cli/          # `openacme` binary — Commander + Ink TUI + Clack setup
  web/          # Next.js 16 chat/agents/skills UI; static-built into packages/server/web
  docs/         # Next.js docs site (placeholder)

packages/
  agent-core/   # Agent class — agentic loop, streaming, history reconstruction
  server/       # Hono HTTP server + AgentManager (multi-agent orchestration)
  cli (apps)    # see above
  llm-provider/ # getModel() — OpenAI / Anthropic / Google / OpenRouter / Ollama / custom
  mcp-client/   # MCP stdio + HTTP/SSE transports; tool discovery into registry
  tools/        # ToolRegistry + built-ins (shell, read_file, write_file, list_files,
                #   search_files, session_search)
  db/           # better-sqlite3 + Drizzle; sessions/messages/agents/user_profiles + FTS5
  config/       # Zod schema + YAML/JSON loader (~/.openacme/config.yaml)
  auth/         # OAuth (ChatGPT subscription, Claude Pro), token store, body/response
                #   transforms, refresh
  skills/       # SKILL.md discovery, progressive disclosure (index → full content)
  ui/           # Shared React components (minimal)
  eslint-config, typescript-config   # @repo/* internal
```

Default data dir: `~/.openacme/` (`config.yaml`, `auth.json` mode 0600, `state.db`).
Default server: `127.0.0.1:3210`. Default model: `openrouter` + `anthropic/claude-sonnet-4-20250514`.

---

## The agent loop — request path

User message → response, end-to-end. File:line refs are anchors to jump to.

1. **Web** `apps/web/app/page.tsx` posts `{ agentId, sessionId?, message }` to `POST /api/chat` and parses SSE lines.
2. **Server route** `packages/server/src/app.ts` (`/api/chat`, ~line 120) generates `sessionId` if missing, emits `session` SSE event first, then iterates `manager.chat()` and writes one SSE event per chunk.
3. **AgentManager** `packages/server/src/agent-manager.ts` looks up / lazily instantiates the `Agent`, then yields straight from `agent.chat()`.
4. **Agent.chat** `packages/agent-core/src/agent.ts:45` (async generator):
   - Ensures session row exists with the **caller-supplied id** (`agent.ts:54`) — critical: server already announced that id over SSE; mismatched ids break history loading on the next turn.
   - Loads history via `MessageStore.getHistory`, normalizes legacy `{id,name,args}` tool-calls, drops assistant tool-calls with no matching tool-result row (ordering rule: tool-result must be the next message).
   - Builds `CoreMessage[]` v3 shape (assistant content-parts include `tool-call` parts; tool messages carry `tool-result` parts).
   - Builds + caches the system prompt per `sessionId` (`prompt.ts`); cache is in-memory on the Agent instance and also persisted via `sessionStore.updateSystemPrompt`. **Manual** invalidation via `invalidateSystemPromptCache()` — no auto-invalidation when tools/skills change.
   - `getModel(config.model)` from `llm-provider`, `toolRegistry.getVercelTools(toolNames)` for the Zod-described tool set.
   - `streamText({ model, system, messages, tools, maxSteps })` — Vercel AI SDK auto-dispatches tool handlers inside the maxSteps loop.
   - Yields `text-delta` | `tool-call` | `tool-result` | `error` | `done` (`types.ts`).
   - On finish: persists each step (assistant text + tool_calls JSON, then one tool message per result), sets a session title from the first response (≤80 chars), touches `updated_at`.
5. **Web** updates message state per chunk, renders text via react-markdown + remark-gfm, tool calls as collapsible blocks.

`StreamChunk` is the contract that crosses agent ↔ server ↔ web. Don't change its shape without updating all three.

---

## Tools

`packages/tools/src/registry.ts` — a singleton `ToolRegistry` keyed by tool name. Built-ins self-register on import (`packages/tools/src/builtins/*`); MCP tools register dynamically and are namespaced `mcp-<server>__<tool>`.

`ToolEntry` shape (see `types.ts`): `name`, `toolset`, `description`, `parameters: ZodSchema`, `handler: (args) => Promise<string>` (return JSON-stringified result), plus optional `emoji`, `parallelSafe`, `maxResultSizeChars`, `checkFn`.

Shadowing rule (`registry.ts:18`): a register call is **rejected** if a different `toolset` already owns the name. Two MCP toolsets *can* overwrite each other (legitimate server refresh).

### Adding a new built-in tool

1. Create `packages/tools/src/builtins/<name>.ts` with a Zod params schema and an `async handler(args) => JSON.stringify(...)`.
2. `registry.register({...})` at module top level.
3. Import the file in `packages/tools/src/index.ts` so it self-registers.
4. Add the tool name to `AgentDefinitionSchema.tools` default in `packages/config/src/schema.ts` if it should ship on by default.
5. Tools are stateless. Long results: enforce a size cap inside the handler (shell uses 50KB; see `shell.ts`).

### Wiring an external store into a tool

`session_search` needs the live DB and is bound at runtime via `bindSessionSearch(messageStore.search)` from `agent-manager.ts`. Mirror this pattern: register the tool with a placeholder handler, expose a `bindX(...)` setter, call it from `AgentManager` after stores exist.

---

## Persistence

`packages/db/src/connection.ts` — better-sqlite3, WAL on, FK on. Tables: `agents`, `sessions`, `messages`, `user_profiles`. `fts_messages` is a content-less FTS5 virtual table kept in sync via insert/update/delete triggers — used by `MessageStore.search()` and the `session_search` tool.

`messages` shape: `id, session_id, role, content, tool_calls (JSON string), tool_call_id, tool_name, created_at`. Assistant turns may set `content` AND `tool_calls`; tool turns set `tool_call_id` + `tool_name`. The agent's history loader expects this exact shape.

Stores (`packages/db/src/stores/*`) are thin: `SessionStore`, `MessageStore`, `AgentStore`. UUIDs are auto-generated when `id` isn't supplied. Don't bypass the stores from app code.

---

## LLM providers

`packages/llm-provider/src/registry.ts:getModel(config)` dispatches by `provider`:

| provider     | adapter                              | OAuth aware | Notes |
|--------------|--------------------------------------|-------------|-------|
| `openai`     | `@ai-sdk/openai`                     | yes         | OAuth flips to ChatGPT Responses API at `OPENAI_INFERENCE_BASE_URL`; custom fetch injects bearer + ChatGPT account headers; `transformCodexOAuthBody` normalizes the body. |
| `anthropic`  | `@ai-sdk/anthropic`                  | yes         | OAuth applies `transformAnthropicOAuthBody` + Claude Code beta headers (interleaved-thinking, tool-streaming, oauth, `context-1m` for 4.6+). Sampling params stripped for 4.7+ even on API-key auth. `transformAnthropicOAuthResponse` strips the `mcp_` prefix from tool ids. |
| `google`     | `@ai-sdk/google`                     | no          | Standard Gemini. |
| `openrouter` | `@ai-sdk/openai-compatible`          | no          | Default in `ConfigSchema`. |
| `ollama`     | `@ai-sdk/openai-compatible`          | no          | Local. |
| `custom`     | `@ai-sdk/openai-compatible`          | no          | Requires `baseUrl`. |

OAuth resolution (`registry.ts:52`): if `auth: "oauth"` explicitly, use OAuth; else if `apiKey` is missing AND a token exists in `auth.json`, fall back silently. Set `OPENACME_DEBUG=1` (or include `auth`) to log the auth path taken.

### Adding a provider

Add the enum value to `ProviderSchema` (`config/src/schema.ts`), add a factory in `llm-provider/src/registry.ts`, document any required headers / body transforms next to the factory.

---

## MCP

`packages/mcp-client/src/client.ts` — `MCPClient.connect(servers)` runs init in parallel with retry (3 attempts, exponential 1/2/4s). Stdio: `StdioClientTransport` with `buildSafeEnv()` filtering credential-shaped env vars. HTTP/SSE: `SSEClientTransport` with headers. After `tools/list`, each tool registers as `mcp-<server>__<tool>` with the discovered Zod schema.

`security.ts:sanitizeError` strips secrets from error strings before they hit logs or the client. Tool results are clipped to `maxResultSizeChars`.

`AgentManager.initMCP()` is called once at server start and again on agent-config change. Per-agent `mcpServers` map lives in `AgentDefinitionSchema`.

---

## CLI

`apps/cli/src/index.ts` — Commander, runs `start` with no subcommand.

Subcommands (`apps/cli/src/commands/`):

- `setup` — Clack-based wizard; writes `~/.openacme/config.yaml` and the first agent.
- `start` — boots the Hono server + opens the web UI.
- `chat` — terminal chat. **In-process**: instantiates `AgentManager` directly and iterates `agent.chat()`; does not hit the HTTP server.
- `login [--provider]`, `logout` — OAuth flows in `@openacme/auth`.

TUI (`apps/cli/src/tui/`) is React-on-Ink. `render.tsx` mounts the app; `state.ts` is a small dispatch reducer; `commands.ts` is the slash-command table (`/new`, `/clear`, `/help`, `/exit`, `/model`, `/agent`). Components: `MessageList`, `MessageBubble`, `ToolBlock`, `MultilineInput`, `ModelPicker`, `AgentPicker`, `StatusLine`, `Banner`, `CommandPalette`. Markdown in terminal via `marked` + `marked-terminal` (`markdown.ts`). Non-TTY input falls through to `headless.ts`.

---

## Web

`apps/web/` — Next.js 16 App Router. Pages: `/` (chat), `/agents`, `/settings`, `/skills`. Tailwind + Radix primitives + react-markdown.

Build → `out/` → copied to `packages/server/web/` and served as static by Hono. `next.config.js` and `apps/web/app/lib/api.ts` carry the API base URL (defaults to `http://localhost:3210`).

There is **no auth on the web ↔ server channel** today — assumes a trusted local environment. Don't add UI features that imply otherwise without first introducing a session/token layer.

SSE parsing lives in `apps/web/app/page.tsx` (~line 234). Event names `session | text-delta | tool-call | tool-result | error | done` must stay in lock-step with the server route and `StreamChunk`.

---

## Auth (`@openacme/auth`)

OAuth for **ChatGPT** subscription and **Claude** subscription. API-key remains the fallback and is used directly by `llm-provider` factories when no OAuth is configured.

Files:
- `oauth-openai.ts`, `oauth-anthropic.ts` — login flows (browser via `loopback.ts` + `pkce.ts`, or device-code for headless).
- `store.ts` — atomic write of `~/.openacme/auth.json` at mode `0600`. Shape: `{ version: 1, openai?, anthropic? }`, each entry: `{ mode, access_token, refresh_token?, id_token?, expires_at, account_id?, last_refresh? }`.
- `refresh.ts:getOAuthToken(provider, dataDir)` — refresh-on-expiry; throws `OAuthRelogin` on hard failure (CLI catches, prompts re-login).
- `transforms-{openai,anthropic}.ts` — body / response normalization for OAuth-bound API contracts (header injection, `mcp_` prefix strip, sampling param strip).
- `security.ts` — credential-string masking for logs.

Never log raw tokens. Never write tokens anywhere except via `store.ts`.

---

## Config

`packages/config/src/schema.ts` is the source of truth. Top-level keys: `dataDir`, `model` (`ModelConfigSchema`), `agents` (array of `AgentDefinitionSchema`), `server` (`port`, `host`), `behavior` (`maxSteps: 10`, `maxIterations: 90`), `skills` (`directory`, `autoGenerate`).

`AgentDefinitionSchema` defaults `tools` to `[shell, read_file, write_file, list_files, search_files, session_search]`. Per-agent `model` overrides the root `model`.

`loader.ts:loadConfig(dataDirOverride?)` resolves the data dir, reads `config.yaml` (or `.json`), merges with defaults, validates with Zod. **Always go through the schema** — don't read raw config elsewhere.

Env vars: `OPENACME_DATA_DIR` (set early by CLI so `auth.json` is findable without threading), `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `OPENROUTER_API_KEY`, `OPENACME_DEBUG`. Dev-only telemetry: `OPENACME_TELEMETRY=1` enables OTel/Logfire export, `LOGFIRE_TOKEN` is the bearer token (loaded from repo-root `.env`); off by default so user installs ship inert.

---

## Skills

`packages/skills/src/registry.ts` — `SkillRegistry.loadFromDirectory(dir)` recursively scans for `SKILL.md` (flat or nested). Frontmatter via `gray-matter`: `name`, `description`, `tags`. Max file size 1MB, symlinks resolved.

Progressive disclosure:
- `getIndex()` / `getIndexAsString()` — name + description + tags only, injected into the system prompt.
- `getSkill(name)` — full markdown, fetched on demand by the `skill_view`-style tool (when present).

Per-agent `skills` array filters which skills are exposed; empty/missing means all.

---

## Conventions

- **TypeScript** strict, ES modules, `.js` import suffix on relative paths (NodeNext). Target Node ≥18.
- **Zod first**: tool params, config schema, agent definitions. Don't hand-roll JSON Schema — use `zodToJsonSchema` (already imported in `tools/registry.ts`).
- **Streams over arrays**: agent code yields `StreamChunk`s; never accumulate the whole response before returning.
- **Stores are the boundary** to SQLite. App code uses `SessionStore` / `MessageStore` / `AgentStore`, not raw `db.prepare`.
- **Errors**: throw `Error` with a clear message; let the agent loop surface it as a `StreamChunk` of type `error`. Don't swallow.
- **No emojis** in code or commit messages unless the user asks.
- **No new docs** unless asked. Working notes belong in PRs / commits, not in `docs/`.
- **Comments**: only for the non-obvious *why*. Don't restate the code. Don't write multi-paragraph docstrings. Keep them short — one or two lines. Long comments tend to go stale and rarely earn their keep.
- **No backwards-compat shims** for unreleased / unpublished surfaces — change the code.

---

## Non-obvious gotchas

- **Session id pinning** — `app.ts` emits the `session` SSE event before `agent.chat` runs; `agent.ts:54` honors that id when creating the row. Breaking this alignment silently corrupts history.
- **Tool-call filtering by message order** — history loader drops an assistant tool-call if the next message isn't its tool-result. Schema doesn't enforce ordering; the persistence path in `agent.ts` does, and you must preserve it.
- **System-prompt cache invalidation is manual.** Changing an agent's tools / skills mid-process won't take effect until you call `invalidateSystemPromptCache()` or restart.
- **OAuth body/response transforms are required for correctness**, not optional polish. Skipping them produces 400s on Anthropic OAuth and tool-id mismatches on streamed responses. Mirror existing transforms when adding a new OAuth-aware provider.
- **Web build → server static**: web changes only land in the served bundle after `apps/web` builds and copies into `packages/server/web/`. Plain `pnpm dev` doesn't do this; it runs Next.js dev and the Hono server side by side.
- **MCP env injection is filtered**. `buildSafeEnv` drops anything that smells like a credential. Pass explicit `env` in `MCPServerConfig` for tokens you actually need.
- **`apps/cli` chat does not call the server** — agent runs in-process. Server-only changes (e.g., HTTP middleware) won't affect terminal chat behavior.

---

## Commands

From repo root:

```
pnpm install                  # install workspace deps
pnpm dev                      # web + @openacme/server in parallel (turbo)
pnpm build                    # build all packages
pnpm check-types              # tsc --noEmit across the workspace
pnpm lint
pnpm test                     # vitest where present (most packages have none yet)
pnpm format                   # prettier

pnpm agent                    # run the CLI (no subcommand → start)
pnpm agent:setup              # interactive setup wizard
pnpm agent:start              # server + web UI
pnpm agent:chat               # terminal chat (in-process)

pnpm changeset                # declare a version bump (interactive)
pnpm version-packages         # consume changesets locally
pnpm release                  # turbo build @openacme/* + changeset publish
```

Per-package: `pnpm --filter @openacme/<pkg> <script>`.

---

## Releasing

Manual via Changesets — see `CONTRIBUTING.md`. Workflow `.github/workflows/release.yml` is `gh workflow run`-only, never automatic. Internal `workspace:*` deps auto-patch-bump per `.changeset/config.json` (`updateInternalDependencies: "patch"`). Provenance is **off** (private repo).

---

## Where to start when…

| Want to… | Open |
|---|---|
| Add a tool | `packages/tools/src/builtins/` + register in `index.ts` |
| Add an LLM provider | `packages/llm-provider/src/registry.ts` + `ProviderSchema` |
| Change agent loop / streaming chunks | `packages/agent-core/src/{agent,types,prompt}.ts` |
| Add an HTTP route | `packages/server/src/app.ts` |
| Add a slash command | `apps/cli/src/tui/commands.ts` + a reducer action in `state.ts` |
| Touch chat UI | `apps/web/app/page.tsx` (+ `app/components/`) |
| Wire a new MCP server | per-agent `mcpServers` in config; nothing code-side if transport is stdio/SSE |
| Add an OAuth provider | `packages/auth/src/oauth-<name>.ts` + `transforms-<name>.ts` + plug into `llm-provider` factory |
| Persist a new field | `packages/db/src/connection.ts` (schema + migration) + the relevant store |
| Add config | `packages/config/src/schema.ts` |
