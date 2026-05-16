import { resolveLocalBinary } from "../binaries.js";
import {
  killChrome,
  launchChrome,
  resolveUserDataDir,
  type RunningChrome,
} from "../chrome.js";
import type { BrowserConfig } from "../types.js";
import type { AcquiredBrowser, BrowserProvider } from "./base.js";

interface AgentSession {
  running: RunningChrome;
}

/**
 * Per-agent local Chrome. Each agent gets its own process under
 * <dataDir>/agents/<id>/browser-profile/ — separate cookies, separate
 * fingerprint, separate ban surface. Lazy: no spawn until first `acquire`.
 *
 * Binary resolution is delegated to `resolveLocalBinary` — handles system
 * Chrome detection, Playwright Chromium auto-install fallback, and the
 * optional cloakbrowser path.
 */
export class LocalChromeProvider implements BrowserProvider {
  readonly name = "local";
  private readonly dataDir: string;
  private readonly cfg: BrowserConfig;
  private sessions = new Map<string, AgentSession>();
  private acquiring = new Map<string, Promise<AcquiredBrowser>>();

  constructor(opts: { dataDir: string; config: BrowserConfig }) {
    this.dataDir = opts.dataDir;
    this.cfg = opts.config;
  }

  isConfigured(): boolean {
    // We can always resolve a binary (system → Playwright auto-install →
    // cloakbrowser); the only configuration error is a bad executablePath
    // override, which surfaces at acquire time.
    return true;
  }

  async acquire(agentId: string): Promise<AcquiredBrowser> {
    if (!agentId) throw new Error("LocalChromeProvider.acquire requires an agentId");
    const existing = this.sessions.get(agentId);
    if (existing && existing.running.proc.exitCode === null) {
      return this.handleFor(agentId, existing);
    }
    if (existing) this.sessions.delete(agentId);
    const inflight = this.acquiring.get(agentId);
    if (inflight) return inflight;
    const p = this.spawnFor(agentId).finally(() => this.acquiring.delete(agentId));
    this.acquiring.set(agentId, p);
    return p;
  }

  private async spawnFor(agentId: string): Promise<AcquiredBrowser> {
    const exe = await resolveLocalBinary({
      kind: this.cfg.localBrowser,
      executablePathOverride: this.cfg.executablePath,
      onProgress: (msg) => {
        // First-use install can take ~30s; surface it so the user (and any
        // chat-UI subscriber listening to stdout) knows the agent is waiting
        // on a download, not stuck.
        console.log(`[browser/local] ${msg}`);
      },
    });
    const userDataDir = resolveUserDataDir(this.dataDir, agentId);
    const running = await launchChrome({
      exe,
      userDataDir,
      headless: this.cfg.headless,
      noSandbox: this.cfg.noSandbox,
    });
    const session: AgentSession = { running };
    this.sessions.set(agentId, session);
    running.proc.once("exit", () => {
      if (this.sessions.get(agentId) === session) this.sessions.delete(agentId);
    });
    return this.handleFor(agentId, session);
  }

  private handleFor(agentId: string, session: AgentSession): AcquiredBrowser {
    return {
      cdpUrl: session.running.cdpUrl,
      release: () => this.releaseAgent(agentId),
    };
  }

  async releaseAgent(agentId: string): Promise<void> {
    const s = this.sessions.get(agentId);
    if (!s) return;
    this.sessions.delete(agentId);
    try {
      await killChrome(s.running);
    } catch {
      // best-effort — shutdown path must not throw
    }
  }

  async releaseAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.releaseAgent(id)));
  }
}
