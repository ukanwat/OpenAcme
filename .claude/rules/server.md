---
paths:
  - "packages/server/**"
---

# server

Hono HTTP API + AgentManager (multi-agent orchestrator). Routes are thin; AgentManager owns state. The chat route uses AI SDK v6's `createUIMessageStream`. Read this before touching `/api/chat`, uploads, or session lifecycle.

## `/api/chat` is `createUIMessageStream` over `Agent.runStream`

The route receives `{ agentId, sessionId?, messages: UIMessage[] }` (sent by `useChat` via `prepareSendMessagesRequest`). Flow:

1. Validate-then-commit pending file URLs (see "Uploads" below).
2. Provider-gate non-text parts via `lookupModelMetadata(...).inputModalities`.
3. Ensure the session row exists with the **caller-supplied id** (or a fresh UUID).
4. `createUIMessageStream({ execute: ({writer}) => { writer.write({type:"data-session", data, transient:true}); const result = await agent.runStream(...); writer.merge(result.toUIMessageStream({sendStart:false})); }, originalMessages, generateId, onFinish: ({responseMessage}) => save(...) })`.
5. Return `createUIMessageStreamResponse({ stream })`.

Don't call `agent.runStream` outside a `createUIMessageStream` execute callback in this route — direct iteration of `result.fullStream` would skip the SDK's UIMessageStream protocol that `useChat` expects.

## Session-id pinning via the `data-session` transient part

The `data-session` part is `transient: true`, so it never lands in `responseMessage.parts` — it's a one-shot signal to `useChat`'s `onData`. The web reads it and pins `activeSessionId` for the next send.

- The session row is created BEFORE `runStream` so the FK in `onFinish`'s `messageStore.append` can't fail.
- If you remove the `data-session` write, every new chat would create a fresh session on every send — the client would lose its pin.

## Uploads: validate-then-commit (no partial-failure orphans)

`/api/uploads` (multipart) writes each file to `<dataDir>/attachments/__pending__/<pendingId>/<filename>` and returns `{pendingId, url, kind, mediaType, size, filename}`. Pending entries live in an in-memory map with a 30-min TTL sweep.

`/api/chat` walks the incoming messages, collects pending IDs from FileUIPart URLs, **verifies all are known FIRST**, then `commit()`s them (renames each file from `__pending__/...` to `<sessionId>/<attId>/<filename>` and rewrites the part URL).

- Don't switch back to a map+commit pattern. Earlier files would move before a later unknown ID triggered a 400 — the moved files become orphans in the session dir with no message row to reference them.
- `commit()` is idempotent per `pendingId` within one request via the local `committedById` cache (multi-part references to the same id, defensive).

## `/api/attachments/:sessionId/:attachmentId/:filename` serves directly off disk

URL → relative path is a 1:1 map. No DB sidecar lookup. Defense-in-depth: the resolved absolute path must start under `<attachmentsRoot>` or the route returns 400.

- Pending files are also served via this route by addressing them as `__pending__/<pendingId>/<filename>` — used for the web's optimistic preview before the file is committed. Same auth gate.

## AgentManager is a singleton; Agent instances are cached

Lazy creation, keyed by agent id. Mutating an `AgentDefinition` in storage does **not** refresh the cached Agent — eviction is explicit.

- New mutation paths (e.g., a `PATCH /api/agents/:id` that changes tools): call `manager.agents.delete(id)` (or any code path that does so) before the next `runStream`, otherwise the cached Agent uses stale tools and a stale system prompt.
- Process restart is the catch-all eviction. Tests should restart, not reuse a manager.

## Runtime-bind tools that need DB or skills state

`session_search` and `skill_view` are **placeholder-registered** in `@openacme/tools` and bound here in `AgentManager`'s constructor with closures over `messageStore.search` and `skillRegistry.getSkill`.

- Do **not** add `@openacme/db` or `@openacme/skills` as a dep of `@openacme/tools` — that breaks the layering and forces the tools package to import sqlite.
- New tool needing live state? Mirror the pattern: register a placeholder in `tools`, expose `bindX(...)`, call it from AgentManager construction.

## `listActive()` hides compressed parents

`sessionStore.listActive()` excludes rows with a child (compression forks). Used for the sidebar listing. For admin/audit paths use `listAllActive`.

## No auth between web ↔ server

Assumes 127.0.0.1. Don't add UI features that imply remote or multi-user access without first introducing a session/token layer — partial auth is worse than none. The secret-cookie `authMiddleware` exists for non-loopback deployments (background daemon mode), not for in-app auth.

## MCP lifecycle

`initMCP()` runs at startup and re-runs on agent-config change. Per-agent clients live in `mcpClients: Map<agentId, MCPClient>`. Removing an agent: clean up its client entry, otherwise zombie stdio processes leak.

## Proactive compression (end-of-turn) lives outside `onFinish`

Today the chat-route `onFinish` only persists messages + sets a session title. It does **not** invoke compression. The compression entry point is `agent.compress(sessionId, "proactive")`, which the route doesn't currently call. (Pre-migration code did; removed because the new shape's compression path is settled but the wire-up was deferred along with reactive 413 retry.) Re-enable both as a follow-up in the same change.
