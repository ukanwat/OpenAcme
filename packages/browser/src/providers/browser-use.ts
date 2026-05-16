import type { AcquiredBrowser, BrowserProvider } from "./base.js";

interface BrowserUseConfig {
  apiKey: string;
  baseUrl: string;
}

interface AgentSession {
  remoteId: string;
  cdpUrl: string;
}

const DEFAULT_BASE_URL = "https://api.browser-use.com/api/v3";
const DEFAULT_TIMEOUT_MIN = 5;

/**
 * Browser Use cloud browser. Best stealth pass rate in the 2026 benchmark.
 * Each agent gets its own remote session.
 *
 * Env vars (read at call time):
 *   BROWSER_USE_API_KEY        — required
 *   BROWSER_USE_BASE_URL       — default https://api.browser-use.com/api/v3
 *   BROWSER_USE_TIMEOUT_MIN    — minutes; default 5
 *   BROWSER_USE_PROXY_COUNTRY  — ISO code; default "us"
 */
export class BrowserUseProvider implements BrowserProvider {
  readonly name = "browser-use";
  private sessions = new Map<string, AgentSession>();
  private acquiring = new Map<string, Promise<AcquiredBrowser>>();

  isConfigured(): boolean {
    return Boolean(process.env.BROWSER_USE_API_KEY);
  }

  private getConfig(): BrowserUseConfig {
    const apiKey = process.env.BROWSER_USE_API_KEY;
    if (!apiKey) {
      throw new Error("Browser Use requires the BROWSER_USE_API_KEY environment variable.");
    }
    return {
      apiKey,
      baseUrl: (process.env.BROWSER_USE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    };
  }

  async acquire(agentId: string): Promise<AcquiredBrowser> {
    if (!agentId) throw new Error("BrowserUseProvider.acquire requires an agentId");
    const existing = this.sessions.get(agentId);
    if (existing) return this.handleFor(agentId, existing);
    const inflight = this.acquiring.get(agentId);
    if (inflight) return inflight;
    const p = this.createFor(agentId).finally(() => this.acquiring.delete(agentId));
    this.acquiring.set(agentId, p);
    return p;
  }

  private async createFor(agentId: string): Promise<AcquiredBrowser> {
    const cfg = this.getConfig();
    const timeoutMin = Number.parseInt(
      process.env.BROWSER_USE_TIMEOUT_MIN ?? String(DEFAULT_TIMEOUT_MIN),
      10
    );
    const body = {
      timeout: Number.isFinite(timeoutMin) && timeoutMin > 0 ? timeoutMin : DEFAULT_TIMEOUT_MIN,
      proxyCountryCode: process.env.BROWSER_USE_PROXY_COUNTRY ?? "us",
    };
    const res = await fetch(`${cfg.baseUrl}/browsers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Browser-Use-API-Key": cfg.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to create Browser Use session: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { id: string; cdpUrl?: string; connectUrl?: string };
    const cdpUrl = data.cdpUrl ?? data.connectUrl ?? "";
    if (!cdpUrl) throw new Error("Browser Use session response missing cdpUrl / connectUrl");
    const session: AgentSession = { remoteId: data.id, cdpUrl };
    this.sessions.set(agentId, session);
    return this.handleFor(agentId, session);
  }

  private handleFor(agentId: string, session: AgentSession): AcquiredBrowser {
    return {
      cdpUrl: session.cdpUrl,
      release: () => this.releaseAgent(agentId),
    };
  }

  async releaseAgent(agentId: string): Promise<void> {
    const s = this.sessions.get(agentId);
    if (!s) return;
    this.sessions.delete(agentId);
    let cfg: BrowserUseConfig;
    try {
      cfg = this.getConfig();
    } catch {
      return;
    }
    try {
      await fetch(`${cfg.baseUrl}/browsers/${s.remoteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Browser-Use-API-Key": cfg.apiKey },
        body: JSON.stringify({ action: "stop" }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // best-effort
    }
  }

  async releaseAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.releaseAgent(id)));
  }
}
