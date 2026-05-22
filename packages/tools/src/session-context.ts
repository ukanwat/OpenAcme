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
  /** Default cwd for filesystem/shell tools — the agent's workspace dir. */
  workspaceDir: string;
  /** Current tool-call id. Set by `Agent.runStream` via the SDK's
   *  `tool.execute({toolCallId})` hook, threaded through here so tools
   *  that produce browser-fetchable media (`read_file` on image/PDF,
   *  `browser_take_screenshot`) can namespace their output filenames
   *  under `<agentDir>/sessions/<sessionId>/tool-calls/<toolCallId>-<basename>`
   *  for serving via the `/api/files/...` route. */
  toolCallId?: string;
  /**
   * Whether the active provider's adapter accepts media of each type
   * inside `tool_result.content`. Populated by `Agent.runStream` from
   * `supportsToolResultMedia(config.model, ...)`. Tools' `toModelOutput`
   * reads this to decide between emitting an AI-SDK content array
   * (native path, cache-friendly) and returning text-only (so the
   * synthetic-user-message injector picks up).
   */
  toolResultMediaSupport?: {
    image: boolean;
    pdf: boolean;
  };
}

export const toolCallContext = new AsyncLocalStorage<ToolCallContext>();

export function getCurrentSessionId(): string | null {
  return toolCallContext.getStore()?.sessionId ?? null;
}

export function getCurrentAgentId(): string | null {
  return toolCallContext.getStore()?.agentId ?? null;
}

export function getCurrentWorkspaceDir(): string | null {
  return toolCallContext.getStore()?.workspaceDir ?? null;
}

export function getCurrentToolCallId(): string | null {
  return toolCallContext.getStore()?.toolCallId ?? null;
}

export function supportsCurrentToolResultMedia(
  mediaType: "image" | "pdf"
): boolean {
  return toolCallContext.getStore()?.toolResultMediaSupport?.[mediaType] ?? false;
}
