/**
 * Browser provider abstraction. The contract is "give me a CDP URL for
 * this agent" — anything that can produce one (local Chrome, stealth
 * Chromium binary, cloud session) slots in here. `acquire(agentId)` and
 * `release()` are idempotent; the provider caches per-agent sessions.
 */

export interface AcquiredBrowser {
  /** CDP websocket URL that playwright-core can `connectOverCDP` to. */
  readonly cdpUrl: string;
  /** Release this agent's session. Must not throw — called from shutdown paths. */
  release(): Promise<void>;
}

export interface BrowserProvider {
  /** Short name shown in logs and diagnostics. */
  readonly name: string;

  /** True when credentials / binary are present. Cheap, no network. */
  isConfigured(): boolean;

  /** Acquire a browser session for `agentId`. Idempotent per id. */
  acquire(agentId: string): Promise<AcquiredBrowser>;

  /** Drop the cached session for `agentId`. Safe when no session held. */
  releaseAgent(agentId: string): Promise<void>;

  /** Release every session. Called at manager shutdown. */
  releaseAll(): Promise<void>;
}
