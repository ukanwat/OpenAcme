---
paths:
  - "packages/server/**"
---

# server

Hono HTTP API + AgentManager (multi-agent orchestrator). Routes are thin; AgentManager owns state. Read this before adding routes, changing chat SSE, or wiring new tools.

## Session-id pinning is load-bearing

`/api/chat` (`app.ts:136`) precomputes `sessionId` (caller-supplied or fresh UUID), emits the `session` SSE event **first**, **then** iterates `agent.chat({ sessionId, ... })`. `Agent.chat` honors that exact id when creating the row.

- If anything downstream mints a fresh id mid-flight, the SSE-announced id and the DB row diverge. Turn 2 loads history from the wrong row and silently truncates.
- New chat-path code: thread the precomputed id through; do not call `randomUUID()` inside the agent loop.

## AgentManager is a singleton; Agent instances are cached

Lazy creation, keyed by agent id. Mutating an `AgentDefinition` in storage does **not** refresh the cached Agent — eviction is explicit.

- New mutation paths (e.g., a `PATCH /api/agents/:id` that changes tools): call the eviction path before the next `chat()`, otherwise the cached Agent uses stale tools and a stale system prompt.
- Process restart is the catch-all eviction. Tests should restart, not reuse a manager.

## Runtime-bind tools that need DB or skills state

`session_search` and `skill_view` are **placeholder-registered** in `@openacme/tools` and bound here (`agent-manager.ts:55`, `:74`) with closures over `messageStore.search` and `skillRegistry.getSkill`.

- Do **not** add `@openacme/db` or `@openacme/skills` as a dep of `@openacme/tools` — that breaks the layering and forces the tools package to import sqlite.
- New tool needing live state? Mirror the pattern: register a placeholder in `tools`, expose `bindX(...)`, call it from AgentManager construction.

## `listActive()` hides compressed parents

`sessionStore.listActive()` excludes rows with a child (compression forks). Used for the sidebar (`app.ts:112` comment explains why). For admin/audit paths use `listAll()`.

## No auth between web ↔ server

Assumes 127.0.0.1. Don't add UI features that imply remote or multi-user access without first introducing a session/token layer — partial auth is worse than none.

## MCP lifecycle

`initMCP()` runs at startup and re-runs on agent-config change. Per-agent clients live in `mcpClients: Map<agentId, MCPClient>`. Removing an agent: clean up its client entry, otherwise zombie stdio processes leak.
