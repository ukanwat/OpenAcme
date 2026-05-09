---
paths:
  - "packages/agent-core/**"
---

# agent-core

`Agent.runStream(opts)` returns an AI SDK `StreamTextResult`; the host (server route or CLI) drives the stream. Compression forks the session and operates on `UIMessage[]`. Read this before changing `Agent.runStream`, the conversion module, or compression.

## `runStream` is the contract — no async generator, no `StreamChunk`

`agent.ts` exposes `runStream({ sessionId, history: UIMessage[], signal? })` which returns the result of `streamText({...})`. **Persistence happens at the caller**, not inside the agent:

- Server: wraps `runStream` in `createUIMessageStream` + `onFinish({ responseMessage })` writes the new user msg + assistant response.
- CLI: consumes `result.fullStream` events, assembles a UIMessage from `text-delta` / `tool-call` / `tool-result` / `tool-input-start` parts, persists at end.

`agent-core` no longer defines its own `StreamChunk` union. Re-exports `UIMessage` / `UIMessagePart` / `ModelMessage` from `ai` so consumers have one import path.

## Inline file attachments before `convertToModelMessages`

`messages.ts:uiToModelMessages` walks every `FileUIPart`, finds local `/api/attachments/<sessionId>/<attId>/<filename>` URLs via `parseAttachmentUrl`, reads bytes off disk, and rewrites the URL to a `data:` URL before `convertToModelMessages`. Providers can't reach 127.0.0.1 — without this, multimodal turns silently fail.

- Other URL shapes (`data:`, external https) pass through unchanged.
- Missing files become a placeholder text part `[attachment unavailable: <name>]` — the message still sends.
- New URL scheme? Extend `parseAttachmentUrl`.

## System prompt cache is manual — two layers

In-memory `cachedSystemPrompts: Map<sessionId, string>` on the Agent **plus** persisted `sessions.system_prompt`. The persistence lets a restarted process keep the same prompt (provider-side cache stays warm) and lets compression forks copy the prompt to the child without rebuilding.

- **No automatic invalidation.** Mutating an agent's tools/skills mid-process is invisible until something calls `invalidateSystemPromptCache(sessionId?)` — pass an id to drop one session, omit to clear all.
- AgentManager evicts on agent-definition mutation. New mutation paths must invalidate, or stale prompts ship silently.

## Compression: flatten UIMessage[] → Step[] → algorithm → coalesce

`compression.ts` operates on an internal `Step` shape (per-step rows: `{id, role, content, toolCalls, toolCallId, toolName, originalParts?}`). The 1300-line algorithm — boundary walker, dedup, prune, summarize, sanitize — runs unchanged on `Step[]`.

- `flattenUIMessages` converts incoming UIMessages to Steps. Each user UIMessage → 1 Step (with `originalParts` stashed). Each assistant UIMessage → 1 assistant Step (toolCalls JSON joined) + 1 tool Step per `output-available` / `output-error` part.
- `stepsToUIMessages` coalesces back. User steps with `originalParts` restore the pristine parts (preserves FileUIParts, etc.). Assistant + following tool steps fold into one UIMessage with `tool-${name}` parts.
- The algorithm itself never reads `originalParts`. Don't drop the field; coalesce of preserved head/tail user messages depends on it.

## Compression preserves attachments via rebind

`Agent.rebindAttachmentsForChild` walks each child user UIMessage's file parts. For URLs rooted at the parent session (`/api/attachments/<parentId>/...`), it copies the bytes to a fresh `<childSessionId>/<newAttId>/<filename>` location and rewrites the URL.

- Without this, the child references files under the parent dir; once the parent session is deleted, the child's renders 404.
- Other URL shapes (`data:`, external, already-child) pass through.

## Compression child rows get fresh ids

`Agent.compress` mints `randomUUID()` for each child message-row id during the `appendMany` map. The Compressor preserves source ids on Steps (head/tail copies) for its own bookkeeping, but those ids already exist in the parent session — rewriting at the persistence boundary avoids primary-key collisions on the same `messages` table.

## Reactive 413/context-overflow retry is currently OFF

The pre-migration shape had a 2-attempt loop that on stream-stopping 413 would compress the parent and retry against the child. With `createUIMessageStream`'s writer pattern, swapping mid-merge is awkward. Disabled in v1 — 413s surface as a stream error and the user retries. Re-add as a follow-up.

- **Proactive compression (end-of-turn) still fires** in any caller that wants it; it's a separate code path on the agent.
- The Compressor's reactive code paths (cooldown, summarizer-failure handling, `payload_too_large` reason) still exist and are tested — just not invoked.

## Tool sessionId comes from `ToolCallContext`, not args

AsyncLocalStorage in `@openacme/tools/session-context.ts`, set at `runStream` entry. Tools needing the session id (`session_search`, etc.) read from it.

- Don't add `sessionId` to tool args — bloats every Zod schema and exposes the id to the model.
- New tools that need session state: `toolCallContext.getStore()?.sessionId` inside the handler.

## File ordering in flatten loses step boundaries

An assistant UIMessage with parts `[text1, tool-X, text2]` flattens with `text1\ntext2` joined into the assistant Step's `content`. On coalesce: one UIMessage with `[text(joined), tool-X]`. The pre/post-tool ordering nuance is gone after a compression round-trip. Acceptable — every shipping provider handles either ordering. Don't try to reconstruct the SDK's `step-start` markers; they're not load-bearing for our use.
