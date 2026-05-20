import type { BrowserManager } from "@openacme/browser";
import { spillSnapshot } from "../../spill.js";

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

/**
 * If the manager result carries a `snapshot` field, spill it to a file in
 * the agent's workspace and replace the field with the relative path.
 * Mirrors Microsoft's playwright-mcp behavior: snapshots are always linked,
 * never inlined, so the model can read them on demand without bloating
 * every action's response.
 *
 * Falls back to leaving the YAML inline if the spill write fails (no
 * workspace, disk full, etc.) — caller still gets a usable result.
 */
export function spillSnapshotField<T extends { snapshot?: string }>(r: T): T {
  if (r.snapshot === undefined || r.snapshot === "") return r;
  const path = spillSnapshot(r.snapshot);
  if (path) r.snapshot = path;
  return r;
}
