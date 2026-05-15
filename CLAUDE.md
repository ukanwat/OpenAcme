# OpenAcme — Claude Code guide

TypeScript agent platform. Multi-provider LLM with streaming tool-calls, SQLite-backed sessions, MCP integration, OAuth (ChatGPT / Claude subscriptions), an Ink-based CLI TUI, and a Next.js web UI served by the Hono server.

**Design lens.** This is an *AI workforce* platform — a structured set of role-specialized agents working for a small human team — not a single-agent assistant. Each agent carries a `name`, a `role` (third-person paragraph for coworkers), and a `persona` (second-person system prompt), and owns its own config, model, tools, skills, MCP servers, sessions, and tasks. When designing new state or behavior, the question is "does this hold for N agents working in parallel under different roles?" — not "does this work for the agent." Anywhere you'd reach for a global table or a singleton, default to scoping by `agent_id` instead. Cross-agent work — one agent assigning a task to another, one agent looking up coworkers via `agent_list` — is a first-class primitive, so anything you add should be addressable by agent.

The task subsystem runs end-to-end today: per-agent file-backed `TaskStore` (`packages/tasks`), `task_*` system tools (`packages/tools/src/builtins/tasks.ts`), and `TaskScheduler` (`packages/server/src/task-scheduler.ts`) that lazily allocates sessions, arms future `start_at`s via croner, runs the agent autonomously through `Agent.runAutonomous`, and self-resets recurring tasks (cron + interval) on `done`. Any agent can `task_create({assignee: other})`.

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
  tools/        # ToolRegistry + built-ins (shell, read_file, write_file, edit,
                #   apply_patch, list_files, search_files, session_search, skill_view,
                #   web_search, web_extract, execute_code, process, memory, task_*)
  db/           # better-sqlite3 + Drizzle; sessions/messages/user_profiles + FTS5
                #   (agents are filesystem-backed under <dataDir>/agents/, not in the DB)
  memory/       # Per-agent persistent MEMORY.md store
  tasks/        # Per-agent task store (filesystem-backed)
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

User message → response, end-to-end. We use AI SDK v6's `UIMessage` shape end-to-end and the SDK's UIMessageStream protocol on the wire.

1. **Web** `apps/web/app/page.tsx` uses `useChat` (`@ai-sdk/react`) + `DefaultChatTransport` with `prepareSendMessagesRequest` to POST `{ agentId, sessionId?, messages: UIMessage[] }` to `/api/chat`.
2. **Server route** `packages/server/src/app.ts` (`/api/chat`):
   - Validates pending FileUIPart URLs, then `commit()`s them (moves bytes from `<dataDir>/attachments/__pending__/` under `<sessionId>/<attId>/<filename>`) and rewrites each part's URL.
   - Provider-gates non-text parts via `lookupModelMetadata(...).inputModalities`.
   - Wraps `Agent.runStream` inside `createUIMessageStream({ execute, originalMessages, generateId, onFinish })`.
   - Writes a transient `data-session` part **before** the model produces tokens so the client can pin the resolved sessionId.
   - `merge`s `result.toUIMessageStream({ sendStart: false })`.
   - In `onFinish({ responseMessage })`: persists the **new** user message + the assembled assistant UIMessage (prior history was already in the DB; the client just sent it back), sets a session title from the first text-part, touches `updated_at`.
3. **AgentManager** `packages/server/src/agent-manager.ts` lazy-creates the `Agent` from the agent definition.
4. **Agent.runStream** (`packages/agent-core/src/agent.ts`):
   - `uiToModelMessages(history, { attachmentsRoot, tools })` — `inlineFileAttachments` rewrites `/api/attachments/...` URLs to `data:` URLs (providers can't reach 127.0.0.1), then defers to SDK's `convertToModelMessages`.
   - Builds + caches the system prompt per `sessionId` (`prompt.ts`); persisted via `sessionStore.updateSystemPrompt`. **Manual** invalidation via `invalidateSystemPromptCache()`.
   - `streamText({ model, system, messages, tools, stopWhen: stepCountIs(maxSteps), abortSignal })`.
   - Returns the `StreamTextResult`; the caller (server route or CLI) drives the stream.
5. **Web** consumes the UIMessageStream automatically via `useChat`. Renders parts (text via react-markdown, tool-${name} as collapsible blocks, file as image preview or chip).

`UIMessage` (from `ai`) is the canonical shape across **DB rows, persistence layer, agent input, server response, web render**. We don't define our own message types — re-exported from `@openacme/agent-core` for convenience.

### Custom data parts

`OpenAcmeDataParts` (in `@openacme/agent-core/src/types.ts`) maps named data-part types to their payload shapes. `OpenAcmeUIMessage = UIMessage<…, OpenAcmeDataParts>` is the type-narrowed variant — both server (`createUIMessageStream<OpenAcmeUIMessage>`) and web (`useChat<OpenAcmeUIMessage>`) use it so `writer.write({type: "data-X", data})` and the matching `onData` callback are end-to-end type-checked.

The web's mirror in `apps/web/app/lib/types.ts` must be kept in sync (web can't import server packages — `// mirrored (not imported)` is the existing pattern).

Two parts today:

- `data-session` — resolved session id; emitted **transient** before any tokens stream so `useChat`'s `onData` can pin `activeSessionId`. Never persisted.
- `data-status` — mid-stream reconciliation hook. **Same `id` from the server replaces the previous part** in `useChat`'s view; useful for "compressing context…" → "done" preludes. Empty `message` clears the entry on the client. Today the type is wired but no path emits it; it's the expansion seat for proactive-compression and tool-prelude UI when those return.

Adding a new data part: extend `OpenAcmeDataParts` in agent-core, mirror in web's `lib/types.ts`, handle it in `useChat({onData})`. Persisted (non-transient) data parts also need a renderer in `MessageBubble`.

---

## Tools

`packages/tools/src/registry.ts` — a singleton `ToolRegistry` keyed by tool name. Built-ins self-register on import (`packages/tools/src/builtins/*`); MCP tools register dynamically and are namespaced `mcp-<server>__<tool>`.

`ToolEntry` shape (see `types.ts`): `name`, `toolset`, `description`, `parameters: ZodSchema`, `handler: (args) => Promise<string>` (return JSON-stringified result), plus optional `emoji`, `parallelSafe`, `maxResultSizeChars`, `checkFn`.

Shadowing rule (`registry.ts:18`): a register call is **rejected** if a different `toolset` already owns the name. Two MCP toolsets *can* overwrite each other (legitimate server refresh).

### Adding a new built-in tool

1. Create `packages/tools/src/builtins/<name>.ts` with a Zod params schema and an `async handler(args) => JSON.stringify(...)`.
2. `registry.register({...})` at module top level.
3. Import the file in `packages/tools/src/index.ts` so it self-registers.
4. Decide the category:
   - **System tool** (always-on, not user-configurable — agent introspection / self-management like `task_*`, `skill_view`, `memory`, `session_search`): add the name to `SYSTEM_TOOLS` in `packages/tools/src/system.ts`. It will be merged into every agent's effective tool set by `AgentManager.createAgentFromDef` and hidden from the web's tool picker.
   - **User-configurable tool** (environment-touching — shell, file IO, web, exec): add to the `tools` default in `AgentDefinitionSchema` (`packages/config/src/schema.ts`) if it should ship on by default. Don't put it in `SYSTEM_TOOLS`.
5. Tools are stateless. Long results: enforce a size cap inside the handler (shell uses 50KB; see `shell.ts`).

### Wiring an external store into a tool

`session_search` needs the live DB and is bound at runtime via `bindSessionSearch(messageStore.search)` from `agent-manager.ts`. Mirror this pattern: register the tool with a placeholder handler, expose a `bindX(...)` setter, call it from `AgentManager` after stores exist.

---

## Persistence

`packages/db/src/connection.ts` — better-sqlite3, WAL on, FK on. Tables: `sessions`, `messages`, `user_profiles`. `fts_messages` is a self-contained FTS5 virtual table kept in sync via triggers that extract text from each message's `parts` JSON. Used by `MessageStore.search()` and the `session_search` tool. Agents are filesystem-backed, not in the DB.

`messages` shape: `id, session_id, role ("user" | "assistant"), parts (JSON UIMessagePart[]), metadata (JSON, optional), created_at`. One row per UIMessage — tool calls + their results live as `tool-${name}` parts inside an assistant message's parts array. File attachments are `file` parts whose `url` is `/api/attachments/<sessionId>/<attId>/<filename>` — the URL alone resolves to disk under `<dataDir>/attachments/`, no sidecar table.

Stores (`packages/db/src/stores/*`) are thin: `SessionStore`, `MessageStore`. `MessageStore.append/getHistory` JSON-stringifies/parses parts at the boundary; consumers see `StoredUIMessage` (id, role, parts: unknown[], metadata?). UUIDs auto-generated when `id` isn't supplied. Don't bypass the stores from app code.

`SessionStore.delete` cascades messages via FK and removes `<attachmentsRoot>/<sessionId>/` from disk. Pass `attachmentsRoot` via `createSessionStore(db, { attachmentsRoot })` to enable the FS hook.

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
- `start` (default) — installs the launchd/systemd unit on first run, boots the Hono daemon, opens the web UI. `--expose` flips bind to 0.0.0.0 + generates an access secret. `--no-service` spawns detached with a PID file instead.
- `stop` / `restart` / `status` / `logs [-f]` — daemon lifecycle + introspection.
- `chat` — terminal chat. **In-process**: instantiates `AgentManager` directly, calls `agent.runStream()`, and consumes `result.fullStream` — no HTTP, no SSE wire format.
- `login [--provider] [--device]`, `logout` — OAuth flows in `@openacme/auth`.
- `secret show|rotate` — manage the access secret used for non-loopback web access.
- `skills list|view|add|remove` — manage installed skills.
- `mcp list|status|remove|test` — manage MCP servers (add/edit happens by editing `<dataDir>/mcp.json` directly).
- `memory status|show <agentId>` — inspect per-agent persistent MEMORY.md.

TUI (`apps/cli/src/tui/`) is React-on-Ink. `render.tsx` mounts the app; `state.ts` reducer carries `committed: UIMessage[]` and an in-flight assistant UIMessage assembled from `result.fullStream` events. `commands.ts` is the slash-command table (`/new`, `/clear`, `/help`, `/exit`, `/model`, `/agent`). Components: `MessageList`, `MessageBubble` (renders UIMessagePart[]), `ToolBlock` (renders ToolUIPart by `state`), `MultilineInput`, `PendingAttachmentsBar`, pickers, `StatusLine`, `Banner`, `CommandPalette`. Markdown via `marked` + `marked-terminal`. Non-TTY → `headless.ts`. Attachments via terminal drag-drop or `@<path>` resolved at submit (`attachments.ts`).

---

## Web

`apps/web/` — Next.js 16 App Router. Pages: `/` (chat), `/agents`, `/settings`, `/skills`. Tailwind + Radix primitives + react-markdown.

**One URL, dev and published: `http://127.0.0.1:3210`.** In dev, Hono fronts both API and UI — `/api/*` is handled in-process; everything else (including `_next/*` HMR over WebSocket) is proxied to a Next dev server bound to a private loopback port. In published installs, the static export at `packages/server/web/` (copied in by `prepack`) is served by Hono on the same `:3210`. `next.config.js`'s rewrites are gone — same-origin works because the browser only ever talks to `:3210`.

Dev wiring: `packages/server/scripts/dev.mjs` and `apps/web/scripts/dev.mjs` share `scripts/lib/dev-ports.mjs`, which reads `<dataDir>/config.yaml`'s `server.port` and derives the web dev port as **`server.port` + 10**. Single source of truth, no env vars. A `~/.openacme-test/config.yaml` with `server.port: 3219` automatically uses `:3229` for `next dev`; two parallel `pnpm dev` sessions against different data dirs just work as long as their API ports differ:

```sh
OPENACME_DATA_DIR=~/.openacme-test pnpm dev   # → :3219 + :3229
```

This is dev-only — published installs serve everything on `server.port` from the bundled static and don't run Next.

The chat page uses `@ai-sdk/react`'s `useChat` with a `DefaultChatTransport` configured via `prepareSendMessagesRequest` to inject `agentId` + `sessionId` into the body each send. Streaming is the SDK's UIMessageStream protocol — the SDK handles parsing; we don't write our own. Custom data parts (`data-session`) arrive via the `onData` callback; `useChat`'s `messages` is the canonical render source.

There is **no auth on the web ↔ server channel** today — assumes a trusted local environment. Don't add UI features that imply otherwise without first introducing a session/token layer.

Attachments: file picker / drag-drop POSTs to `/api/uploads` first → server returns `{pendingId, url: "/api/attachments/__pending__/<id>/<file>"}`. Web stages chips with the pending URL, then `sendMessage({ role:"user", parts: [{type:"text",text}, {type:"file", url, mediaType, filename}] })`. Server's `/api/chat` resolves pending URLs to committed ones at persist time.

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

`packages/config/src/schema.ts` is the source of truth. Top-level keys: `dataDir`, `model` (`ModelConfigSchema`), `server` (`port`, `host`), `behavior` (`AgentBehaviorSchema` — `maxSteps: 1000` + compression knobs), `skills` (`directory`, `autoGenerate`), `web` (`searchProvider`, `searchApiKey`). **Agents are not in `config.yaml`** — each lives at `<dataDir>/agents/<id>/AGENT.md` (YAML frontmatter + system-prompt body) and is read/written by `AgentStore`.

`AgentDefinitionSchema` defaults `tools` to `[shell, read_file, write_file, edit, apply_patch, list_files, search_files, session_search, skill_view, web_search, web_extract, execute_code, process, memory, task_list, task_view, task_create, task_update]`. Per-agent `model` overrides the root `model`. Other agent fields: `persona`, `mcpServers` (private), `mcpDisabled` (excludes from global catalog), `skills`, `memoryCharLimit` (default 2200).

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

## Tasks & the scheduler

`@openacme/tasks` is one filesystem store under `<dataDir>/tasks/<id>.md` (YAML frontmatter + markdown body), shared by all agents. Per-agent isolation is by `assignee`, not by store. `task_list` / `task_view` / `task_create` / `task_update` / `task_comment` / `task_comments` are **system tools** (always on, hidden from the picker; see `SYSTEM_TOOLS` in `packages/tools/src/system.ts`).

Tasks are documents (filesystem). **Comments and events live in SQLite** (`task_comments`, `task_events`) — they're message-shaped (high-frequency, append-only, queryable) and don't belong inside the task body. Body is the spec; comments are the discussion; events are the signal log.

`TaskStore` enforces the invariants:
- cycle-free `depends_on` (DFS on write); unmet deps force `blocked`, satisfied deps auto-flip back to `open`.
- at most one `in_progress` per `session_id`.
- on `done`, dependents auto-unblock; a **recurring** task self-resets to `open` with the next fire time (so the returned status is `open`, not `done`) — `canceled` is the only way to stop a recurrence permanently.
- inputs validated against the frontmatter schema at the write boundary so a bad PATCH can't land malformed YAML on disk.
- `addComment`, `listComments`, `latestResult`, `commentCounts` delegate to the injected `CommentStore`. Mutating paths (`create` / `update` / `addComment` / `unblockDependents`) emit events via the injected `EventStore`. Both stores are optional — tests can omit them and the methods no-op.

### Agent-driven task selection

The scheduler is the **wake mechanism**, not the dispatcher. `runAutonomous({sessionId})` (no `taskId`) brings the agent to life with full queue + recent-activity context in the prompt; the agent picks what to work on and calls `task_update(in_progress)` itself when claiming. Failure attribution is post-hoc: on `AutonomousTurnTimeout` or generic error, the scheduler reads "which task in this session is `in_progress`" and parks *that* one as `blocked` with a `system:scheduler` comment.

### Wake policy (event-driven)

`TaskScheduler` (`packages/server/src/task-scheduler.ts`) is **pure event-driven** — no periodic tick. All runtime wakes flow through `onEvent`; time-based wakes through croner; everything else through a one-shot `startupSweep`.

- `start()` runs `sweepStale` (in_progress > 10 min → open), then `startupSweep` once: allocate sessions for any unbound ready tasks the daemon picked up from disk, arm crons for future `start_at`s, and immediately enqueue wakes for sessions that have eligible work.
- `onEvent(event)` is the **only runtime wake path** — wired to `EventStore.onEmit` in `AgentManager`. Unified for every kind (no hard-eligibility special-casing). For each event: resolve the task, skip terminal status, arm a cron if `start_at` is future, allocate a session inline if unbound, echo-check (`event.actor === session.agentId` AND session existed before this event → drop), then `scheduleWake`.
- `scheduleWake` debounces 7s to coalesce bursts and floors a 10s gap between successive wakes per session. Rate-limit is a **delay, not a drop** — events that arrive in the floor window fire when it opens. Events arriving DURING a turn set `wakeRequestedDuringTurn` so the wake re-fires after the turn ends.
- `task_assigned` is emitted with `actor: null` — new work shouldn't be echo-suppressed, otherwise a self-assigned task in the agent's own session never wakes. Creator info is in the payload.
- `reconcile()` (called via `TaskStore.setOnChange`) covers the few mutations that don't emit events (e.g. a bare `start_at` patch with no status change) — re-arms crons only, no wakes.
- Per-agent serialization via `chains` map; `pendingSessions` set dedups concurrent wakes.

### Mid-turn event injection

`Agent.runAutonomous` passes a `prepareStep` callback to `streamText`. Between LLM steps, fresh events for the session (excluding self-authored) get appended as a system message before the next inference call — the agent reacts to events that landed mid-turn without waiting for the next wake. Capped at 5 injections per turn to bound runaway loops.

### Editing the task model

- New frontmatter field: add to `TaskFrontmatterSchema` + `TaskCreate` / `TaskUpdate` + `TaskCreateInputSchema` / `TaskUpdateInputSchema` (write-boundary guards). Don't skip the second pair — `update()` would happily persist garbage.
- New status: extend `TASK_STATUSES`, then audit `computeAutoStatus`, the closing branches in `update()`, and the recurring-task self-reset.
- New recurrence kind: extend the discriminated union in both `types.ts` and the tool params in `builtins/tasks.ts`; add a branch in `computeNextFire` + `validateRecurrence`.
- New comment kind: add to the tool's Zod enum (currently only `result` is exposed; `system` is reserved and rejected by both the tool and HTTP routes).
- New event kind: add to the `EventKind` union in `packages/tasks/src/ports.ts`, emit at the appropriate site in `TaskStore`, and add a `summarizeEventPayload` branch so the prompt's `## Recent activity` section formats it.

### `task-scheduler.ts` test coverage

Lives at `packages/server/test/task-scheduler.test.ts` (real DB + temp filesystem + mock AgentManager). Covers wake-only behavior, on-timeout park with `system:scheduler` comments, lazy session allocation, dep-blocking, wake policy (echo suppression, debounce, hard-eligibility bypass), recurring self-reset, and agent-missing handling. Add tests for any path you touch — the scheduler is still the most state-dense file in the repo.

---

## Conventions

- **TypeScript** strict, ES modules, `.js` import suffix on relative paths (NodeNext). Target Node ≥18.
- **Zod first**: tool params, config schema, agent definitions. Don't hand-roll JSON Schema — use `z.toJSONSchema` (registry uses it).
- **AI SDK types end-to-end**: persist + render `UIMessage` / `UIMessagePart`. Don't define parallel message types in app code; re-export from `@openacme/agent-core` (which re-exports from `ai`).
- **Stores are the boundary** to SQLite. App code uses `SessionStore` / `MessageStore`, not raw `db.prepare`. Agents are filesystem-backed via `AgentStore` (YAML), not in the DB.
- **Errors**: throw `Error` with a clear message. The server's `createUIMessageStream` surfaces it as a stream error; the CLI's `result.fullStream` `error` event handles the same. Don't swallow.
- **No emojis** in code or commit messages unless the user asks.
- **No new docs** unless asked. Working notes belong in PRs / commits, not in `docs/`.
- **Comments**: keep short or don't write them. See the **Comments** section below — this is enforced.
- **No backwards-compat shims** for unreleased / unpublished surfaces — change the code.

---

## Comments

**Short, or nothing.** One line target, two cap. No multi-line blocks. Long comments are usually not useful — they're skimmed past and rot fastest.

**Don't be too specific.** Naming exact functions, callers, line numbers, file paths, or "this used by X / added for Y" pins the comment to a snapshot of the code. The code moves; the comment lies. Describe the *why* at the level of the invariant, not the surrounding scaffolding.

Write one only when the *why* is genuinely non-obvious from the code. A clear name plus a tight signature usually says enough.

Comments rot. Every reader has to decide whether they're still true, and the cost compounds across the codebase. Long *why* belongs in the commit message. On review, the default action against a stray multi-line or over-specific comment is to delete or compress it.

---

## Non-obvious gotchas

- **Session id pinning via transient data part** — server emits `data-session` (transient) inside `createUIMessageStream` BEFORE merging `result.toUIMessageStream()`. useChat's `onData` reads it and pins `activeSessionId` for subsequent sends. The session row is created up-front in the route so the FK in the message persist on `onFinish` doesn't fail. Don't move the row creation; don't drop the transient `data-session`.
- **Reactive 413 retry is currently disabled.** The pre-migration shape had a two-attempt loop that compressed-and-retried on context-overflow. With `createUIMessageStream` that requires aborting a partly-merged writer; we deferred it. 413s surface as stream errors today. Re-add as a follow-up.
- **System-prompt cache invalidation is manual.** Changing an agent's tools / skills mid-process won't take effect until you call `invalidateSystemPromptCache()` or restart. AgentManager evicts the cached `Agent` on agent-definition mutation.
- **Attachment URLs round-trip to disk paths** — `/api/attachments/<sessionId>/<attId>/<filename>` serves directly from `<dataDir>/attachments/<sessionId>/<attId>/<filename>`. No DB sidecar lookup. Pre-chat uploads land under `__pending__/<pendingId>/...` and `commit()` (in `routes/uploads.ts`) moves them under the real session at `/api/chat` time.
- **`inlineFileAttachments` is required at chat time.** Providers can't fetch our local URLs; the agent reads the bytes off disk and rewrites to a `data:` URL before `convertToModelMessages`. If you add a new local-URL scheme, extend `parseAttachmentUrl` in `messages.ts`.
- **Compression preserves FileUIParts via `originalParts` + `rebindAttachmentsForChild`.** The internal Step shape would otherwise drop file parts on user messages; flatten stashes the pristine parts, coalesce restores them, and `Agent.compress` copies the bytes under the child session dir + rewrites URLs. Don't strip `originalParts` from `Step`; don't skip the rebind.
- **OAuth body/response transforms are required for correctness**, not optional polish. Skipping them produces 400s on Anthropic OAuth and tool-id mismatches. Mirror existing transforms when adding a new OAuth-aware provider.
- **One URL in dev and published — `:3210`.** In dev (`OPENACME_DEV_PROXY_TARGET` set), Hono proxies non-API HTTP and WS upgrades to an internal `next dev` (default `:3220`, loopback-bound). The Next dev port is reachable on the box but isn't printed and isn't the canonical URL — open `:3210`. In published installs Hono serves the bundled static at `packages/server/web/` (filled by `prepack`) on `:3210`. Daemons started without the proxy env (e.g. test slots via `pnpm agent start --data-dir ~/.openacme-test`) prefer the bundled path and fall back to the workspace `apps/web/out` if you've built it — keep that fallback for test-daemon UI; just don't let it activate under the proxy (it would shadow the proxy and double-serve).
- **MCP env injection is filtered**. `buildSafeEnv` drops anything that smells like a credential. Pass explicit `env` in `MCPServerConfig` for tokens you actually need.
- **`apps/cli` chat does not call the server** — agent runs in-process via `agent.runStream`. Server-only changes (HTTP middleware, /api/chat handler) won't affect terminal chat behavior.
- **Scheduler errors land as `system:scheduler` comments, not body suffixes.** Pre-Tasks-v2 the scheduler appended `> [scheduler] turn timed out at ...` to the task body. New code emits a `kind: "system"` comment via `TaskStore.addComment` and the body stays clean. Pre-existing tasks still carry the historical body suffixes; no migration ran.
- **One slice per task tool.** `task_view` returns frontmatter + body only (no comments, no events). `task_comments` and the `/api/tasks/:id/comments` route return comments only. `/api/tasks/:id/events` returns the event log only. Don't bundle these — the cost compounds across calls and agents only pay for what they ask for.
- **Per-session events cursor is `sessions.last_seen_event_ts`.** Updated at the end of every successful autonomous turn so the next turn's `## Recent activity` section is incremental. New sessions inherit `created_at` so their first turn sees nothing-from-before.

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

pnpm agent                    # run the CLI (no subcommand → start daemon + open web UI)
pnpm agent setup              # interactive setup wizard
pnpm agent start              # start daemon (idempotent; --expose for network bind)
pnpm agent stop               # stop daemon
pnpm agent restart            # restart daemon
pnpm agent status             # pid, bind, uptime, recent log
pnpm agent logs [-f]          # print or follow daemon log
pnpm agent chat               # terminal chat (in-process; no server needed)
pnpm agent login --provider <openai|anthropic>   # OAuth subscription sign-in
pnpm agent skills|mcp|memory  # subcommand groups; run with no args for help

pnpm changeset                # declare a version bump (interactive)
pnpm version-packages         # consume changesets locally
pnpm release                  # turbo build @openacme/* + changeset publish
```

Per-package: `pnpm --filter @openacme/<pkg> <script>`.

### Running a daemon to test changes

**Default — use the dev server against the test slot.** Code changes (server *and* web) hot-reload, so you don't have to rebuild after every edit. Drive it like:

```
OPENACME_DATA_DIR=~/.openacme-test pnpm dev
```

Pre-reqs (one time): write `~/.openacme-test/config.yaml` with `server: { port: 3211 }` and create at least one agent under `~/.openacme-test/agents/`. The web dev port is derived from `server.port + 10` automatically — no port flags. The user's real daemon on `:3210` (if running) is untouched because both `server.port` and the derived web port differ.

Don't `pnpm agent start` against the user's real data dir to "test" something — it kills their running daemon and dirties their sessions. Reach for the production daemon path only if you specifically need to validate the bundled-static install path.

For pure API smoke tests (no UI), the bundled-daemon path still works against the test slot:

```
pnpm agent start   --data-dir ~/.openacme-test --no-service --no-browser
pnpm agent restart --data-dir ~/.openacme-test --no-service --no-browser
pnpm agent stop    --data-dir ~/.openacme-test --no-service
pnpm agent status  --data-dir ~/.openacme-test --no-service
```

This serves the bundled UI if you've run `pnpm build` first (Hono falls back to `apps/web/out/` when `OPENACME_DEV_PROXY_TARGET` is unset). `--no-service` keeps it as a detached process; always `restart` rather than spawning a second daemon on the same slot.

**Driving the browser for UI tests.** Playwright CLI is available globally; install Chromium once in a scratch dir (`mkdir -p /tmp/pwt && cd /tmp/pwt && npm i @playwright/test && npx playwright install chromium`) and drive the UI from a one-shot `.mjs` calling `chromium.launch()`. Take screenshots, open them via the Read tool, and verify visually — don't trust the agent's narrative without looking at the actual render.

---

## Releasing

Manual via Changesets — see `CONTRIBUTING.md`. Workflow `.github/workflows/release.yml` is `gh workflow run`-only, never automatic. Internal `workspace:*` deps auto-patch-bump per `.changeset/config.json` (`updateInternalDependencies: "patch"`). Provenance is **off** (private repo).

---

## Where to start when…

| Want to… | Open |
|---|---|
| Add a tool | `packages/tools/src/builtins/` + register in `index.ts` |
| Add an LLM provider | `packages/llm-provider/src/registry.ts` + `ProviderSchema` |
| Change agent loop | `packages/agent-core/src/{agent,messages,prompt}.ts` |
| Change compression | `packages/agent-core/src/compression.ts` (operates on `Step[]` flattened from `UIMessage[]`) |
| Add an HTTP route | `packages/server/src/app.ts` |
| Add a slash command | `apps/cli/src/tui/commands.ts` + a reducer action in `state.ts` |
| Touch chat UI | `apps/web/app/page.tsx` (+ `app/components/`) |
| Add a custom UIMessage data part | server: `writer.write({type:"data-X", data, transient?})`; web: read in `useChat({ onData })` |
| Wire a new MCP server | per-agent `mcpServers` in config; nothing code-side if transport is stdio/SSE |
| Add an OAuth provider | `packages/auth/src/oauth-<name>.ts` + `transforms-<name>.ts` + plug into `llm-provider` factory |
| Persist a new field | `packages/db/src/schema.ts` + `pnpm db:generate` + the relevant store |
| Add config | `packages/config/src/schema.ts` |
| Change task state model / recurrence | `packages/tasks/src/{store,recurrence,types}.ts` |
| Change autonomous wake / scheduling | `packages/server/src/task-scheduler.ts` (+ `Agent.runAutonomous` in `packages/agent-core/src/agent.ts`) |
| Add a task tool | `packages/tools/src/builtins/tasks.ts` — register, add to `SYSTEM_TOOLS` in `packages/tools/src/system.ts` |
