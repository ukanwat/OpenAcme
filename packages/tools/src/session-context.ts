import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-call context made available to tool handlers via AsyncLocalStorage.
 *
 * Vercel AI SDK's `tool({execute})` only forwards the parsed args; there's
 * no first-class way to thread session identity through. We use `enterWith`
 * at the start of `Agent.chat`'s streamText invocation so any tool dispatched
 * inside the SDK's loop can read the active sessionId without changing
 * every tool's signature.
 *
 * Currently consumed by `session_search` to (a) exclude the current
 * conversation's lineage from cross-session results and (b) collapse chains
 * of compression forks back to one root.
 */
export interface ToolCallContext {
  sessionId: string;
}

export const toolCallContext = new AsyncLocalStorage<ToolCallContext>();

export function getCurrentSessionId(): string | null {
  return toolCallContext.getStore()?.sessionId ?? null;
}
