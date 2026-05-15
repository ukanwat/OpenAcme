import type { BrowserManager } from "@openacme/browser";

export interface BrowserBindings {
  manager: BrowserManager;
}

// Bound at runtime by AgentManager so this package stays free of a runtime
// dependency on @openacme/browser. Mirrors session-search.ts pattern.
let bindings: BrowserBindings | null = null;

export function bindBrowser(b: BrowserBindings): void {
  bindings = b;
}

/** Returns the manager or null if bindBrowser hasn't been called yet. */
export function getBrowserBindings(): BrowserBindings | null {
  return bindings;
}

/** Convenience: returns a JSON-stringified error result if not bound. */
export function notBoundError(toolName: string): string {
  return JSON.stringify({
    error: `${toolName} not initialized — AgentManager must call bindBrowser().`,
  });
}

/** Returns the agentId from AsyncLocalStorage or a JSON-stringified error. */
export function requireAgentIdOr(
  toolName: string,
  agentId: string | null
): string | null {
  if (!agentId) {
    return JSON.stringify({
      error: `${toolName} requires an active agent context.`,
    });
  }
  return null;
}

/** Marshal an unknown error into a JSON tool result. */
export function toolError(toolName: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return JSON.stringify({ error: `${toolName} failed: ${msg}` });
}
