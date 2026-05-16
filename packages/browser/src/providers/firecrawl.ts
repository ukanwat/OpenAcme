import type { AcquireOptions, AcquiredBrowser, BrowserProvider } from "./base.js";

interface FirecrawlConfig {
  apiKey: string;
  baseUrl: string;
}

interface AgentSession {
  remoteId: string;
  cdpUrl: string;
}

const DEFAULT_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_TTL_S = 300;

/**
 * Firecrawl cloud browser. Each agent gets its own remote session.
 *
 * Env vars (read at call time):
 *   FIRECRAWL_API_KEY       — required
 *   FIRECRAWL_API_URL       — default https://api.firecrawl.dev
 *   FIRECRAWL_BROWSER_TTL   — seconds; default 300
 */
export class FirecrawlProvider implements BrowserProvider {
  readonly name = "firecrawl";
  private sessions = new Map<string, AgentSession>();
  private acquiring = new Map<string, Promise<AcquiredBrowser>>();

  isConfigured(): boolean {
    return Boolean(process.env.FIRECRAWL_API_KEY);
  }

  private getConfig(): FirecrawlConfig {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Firecrawl requires the FIRECRAWL_API_KEY environment variable. Get one at https://firecrawl.dev"
      );
    }
    return {
      apiKey,
      baseUrl: (process.env.FIRECRAWL_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    };
  }

  async acquire(agentId: string, opts?: AcquireOptions): Promise<AcquiredBrowser> {
    if (!agentId) throw new Error("FirecrawlProvider.acquire requires an agentId");
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
    const ttl = Number.parseInt(
      process.env.FIRECRAWL_BROWSER_TTL ?? String(DEFAULT_TTL_S),
      10
    );
    // Per-agent profile binding: agent override (`browser.firecrawl.profileName`
    // in AGENT.md) wins, env var is workforce fallback, else default to agentId.
    // Sessions sharing a name share storage, so default-to-agentId gives clean
    // per-agent isolation with zero config.
    const profileName =
      opts?.overrides?.firecrawl?.profileName ?? process.env.FIRECRAWL_PROFILE_NAME ?? agentId;
    const res = await fetch(`${cfg.baseUrl}/v2/browser`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_S,
        profile: { name: profileName, saveChanges: true },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to create Firecrawl session: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { id: string; cdpUrl: string };
    const session: AgentSession = { remoteId: data.id, cdpUrl: data.cdpUrl };
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
    let cfg: FirecrawlConfig;
    try {
      cfg = this.getConfig();
    } catch {
      return;
    }
    try {
      await fetch(`${cfg.baseUrl}/v2/browser/${s.remoteId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
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
