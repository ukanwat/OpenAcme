import type { AcquireOptions, AcquiredBrowser, BrowserProvider } from "./base.js";

interface BrowserbaseConfig {
  apiKey: string;
  projectId: string;
  baseUrl: string;
}

interface AgentSession {
  bbSessionId: string;
  cdpUrl: string;
}

/**
 * Browserbase cloud browser. Each agent gets its own remote session.
 *
 * Env vars (read at call time):
 *   BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID  — required
 *   BROWSERBASE_BASE_URL                         — default https://api.browserbase.com
 *   BROWSERBASE_PROXIES                          — default "true"
 *   BROWSERBASE_ADVANCED_STEALTH                 — default "false" (paid)
 *   BROWSERBASE_KEEP_ALIVE                       — default "true"  (paid)
 *   BROWSERBASE_SESSION_TIMEOUT                  — ms
 *
 * 402 (paid feature unavailable) → retry without the feature so free-tier
 * users still get a session.
 */
export class BrowserbaseProvider implements BrowserProvider {
  readonly name = "browserbase";
  private sessions = new Map<string, AgentSession>();
  private acquiring = new Map<string, Promise<AcquiredBrowser>>();

  isConfigured(): boolean {
    return Boolean(process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID);
  }

  private getConfig(): BrowserbaseConfig {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    if (!apiKey || !projectId) {
      throw new Error(
        "Browserbase requires BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID environment variables."
      );
    }
    return {
      apiKey,
      projectId,
      baseUrl: (process.env.BROWSERBASE_BASE_URL ?? "https://api.browserbase.com").replace(/\/+$/, ""),
    };
  }

  async acquire(agentId: string, opts?: AcquireOptions): Promise<AcquiredBrowser> {
    if (!agentId) throw new Error("BrowserbaseProvider.acquire requires an agentId");
    const existing = this.sessions.get(agentId);
    if (existing) return this.handleFor(agentId, existing);
    const inflight = this.acquiring.get(agentId);
    if (inflight) return inflight;
    const p = this.createFor(agentId, opts).finally(() => this.acquiring.delete(agentId));
    this.acquiring.set(agentId, p);
    return p;
  }

  private async createFor(agentId: string, opts?: AcquireOptions): Promise<AcquiredBrowser> {
    const cfg = this.getConfig();
    const enableProxies = (process.env.BROWSERBASE_PROXIES ?? "true").toLowerCase() !== "false";
    const enableAdvancedStealth = (process.env.BROWSERBASE_ADVANCED_STEALTH ?? "false").toLowerCase() === "true";
    const enableKeepAlive = (process.env.BROWSERBASE_KEEP_ALIVE ?? "true").toLowerCase() !== "false";
    const customTimeout = process.env.BROWSERBASE_SESSION_TIMEOUT;

    const body: Record<string, unknown> = { projectId: cfg.projectId };
    if (enableKeepAlive) body.keepAlive = true;
    if (customTimeout) {
      const t = Number.parseInt(customTimeout, 10);
      if (Number.isFinite(t) && t > 0) body.timeout = t;
    }
    if (enableProxies) body.proxies = true;
    // Per-agent context (cookies / login state). Provisioned upstream by
    // AgentManager.ensureBrowserbaseContext; persist=true writes session
    // deltas back so the next session inherits them.
    const browserSettings: Record<string, unknown> = {};
    if (enableAdvancedStealth) browserSettings.advancedStealth = true;
    const contextId = opts?.overrides?.browserbase?.contextId;
    if (contextId) browserSettings.context = { id: contextId, persist: true };
    if (Object.keys(browserSettings).length > 0) body.browserSettings = browserSettings;

    let res = await this.postSession(cfg, body);
    if (res.status === 402 && enableKeepAlive) {
      delete body.keepAlive;
      res = await this.postSession(cfg, body);
    }
    if (res.status === 402 && enableProxies) {
      delete body.proxies;
      res = await this.postSession(cfg, body);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to create Browserbase session: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { id: string; connectUrl: string };
    const session: AgentSession = { bbSessionId: data.id, cdpUrl: data.connectUrl };
    this.sessions.set(agentId, session);
    return this.handleFor(agentId, session);
  }

  private async postSession(cfg: BrowserbaseConfig, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${cfg.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BB-API-Key": cfg.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
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
    let cfg: BrowserbaseConfig;
    try {
      cfg = this.getConfig();
    } catch {
      return;
    }
    try {
      await fetch(`${cfg.baseUrl}/v1/sessions/${s.bbSessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BB-API-Key": cfg.apiKey },
        body: JSON.stringify({ projectId: cfg.projectId, status: "REQUEST_RELEASE" }),
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
