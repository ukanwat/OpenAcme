import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-call context made available to tool handlers via AsyncLocalStorage.
 *
 * Vercel AI SDK's `tool({execute})` only forwards the parsed args; there's
 * no first-class way to thread session identity through. We use `enterWith`
 * at the start of `Agent.runStream`'s streamText invocation so any tool
 * dispatched inside the SDK's loop can read the active session/agent ids
 * without changing every tool's signature.
 *
 * Consumed by:
 *   - `session_search` — uses `sessionId` to exclude the current
 *     conversation's lineage from cross-session results and collapse
 *     compression chains to one root.
 *   - `memory` — uses `agentId` to locate the per-agent MEMORY.md file.
 */
export interface ToolCallContext {
  sessionId: string;
  agentId: string;
}

export const toolCallContext = new AsyncLocalStorage<ToolCallContext>();

export function getCurrentSessionId(): string | null {
  return toolCallContext.getStore()?.sessionId ?? null;
}

export function getCurrentAgentId(): string | null {
  return toolCallContext.getStore()?.agentId ?? null;
}
