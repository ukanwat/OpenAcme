---
paths:
  - "packages/agent-core/**"
---

# agent-core

The agentic loop. Async generator producing `StreamChunk`s; persists via stores; compresses via a session-fork pattern. Read this before changing `Agent.chat`, history loading, or compression.

## System prompt cache is manual — two layers

In-memory `cachedSystemPrompts: Map<sessionId, string>` on the Agent **plus** persisted `sessions.system_prompt`. The persistence lets a restarted process keep the same prompt (provider-side cache stays warm) and lets compression forks copy the prompt to the child without rebuilding.

- **No automatic invalidation.** Mutating an agent's tools/skills mid-process is invisible until something calls `invalidateSystemPromptCache(sessionId?)` (`agent.ts:531`) — pass an id to drop one session, omit to clear all.
- AgentManager evicts on agent-definition mutation. New mutation paths must invalidate, or stale prompts ship silently.

## History loader drops orphan tool-calls

`buildCoreMessages` (`agent.ts:357`) walks rows in order. An assistant tool-call whose **next row** isn't its matching `tool-result` is dropped (see comment at `agent.ts:354`). The DB schema does not enforce ordering — the streaming-loop persistence path does.

- Out-of-order writes silently shrink history next turn. Model loses tool context, quality degrades, no error surfaces.
- Rows are sorted `(created_at, rowid)`. Compression copies tail messages with identical `created_at`, so `rowid` is the tie-break that keeps call/result pairs adjacent. Don't drop rowid from the sort.

## Compression forks the session, never deletes

`createChildIfNoSibling` (`agent.ts:306`) creates a child `sessions` row pointing at the parent, copies tail messages, swaps `sessionId` in-flight, and emits a `session` SSE event so web/CLI re-anchor.

- Parent rows are hidden by `sessionStore.listActive()` (filters rows that have a child) — never deleted. Full audit chain preserved.
- Compression state lives on `Compressor` (`compression.ts`); fork triggers `compressor.inheritState(parent, child)` to migrate it. New compaction strategies plug in there.
- Two-attempt loop: stream once → on 413/context-overflow caught by `error-classifier.ts`, compress and retry. **Both attempts persist their messages.** Do not assume attempt-1 was rolled back.

## `StreamChunk` is a 3-site contract

`types.ts` defines the union. Flow: agent yields → `packages/server/src/app.ts:136` writes one SSE event per chunk → `apps/web/app/page.tsx:274` dispatches by `type`. The CLI's headless path also reads StreamChunk directly.

- Adding a new `type`: edit all three sites. Forgetting one drops the chunk silently.
- Adding a field to an existing type: check both parsers — they currently destructure known fields.

## Tool sessionId comes from `ToolCallContext`, not args

AsyncLocalStorage in `@openacme/tools/session-context.ts`, set at `chat()` entry (`agent.ts:108`). Tools needing the session id (`session_search`, etc.) read from it.

- Don't add `sessionId` to tool args — bloats every Zod schema and exposes the id to the model.
- New tools that need session state: `toolCallContext.getStore()?.sessionId` inside the handler.
