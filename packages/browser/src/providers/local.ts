import type { BrowserContext } from "playwright-core";
import { resolveLocalBinary } from "../binaries.js";
import {
  killChrome,
  launchChrome,
  resolveUserDataDir,
  type RunningChrome,
} from "../chrome.js";
import type { BrowserConfig } from "../types.js";
import type { AcquiredBrowser, BrowserProvider } from "./base.js";

interface SpawnedSession {
  kind: "spawn";
  running: RunningChrome;
}

interface ContextSession {
  kind: "context";
  context: BrowserContext;
}

type AgentSession = SpawnedSession | ContextSession;

/**
 * Per-agent local Chrome. Each agent gets its own session under
 * <dataDir>/agents/<id>/browser-profile/.
 *
 * Two backends:
 *   - "spawn": we fork the binary and the manager attaches via CDP. Used
 *     for stock Chromium + the executablePath override.
 *   - "context": the binary's wrapper (currently Camoufox) drives the
 *     launch through Playwright's launchPersistentContext. We get a
 *     BrowserContext back and skip the manager's CDP attach — needed for
 *     non-CDP browsers (Firefox) and for adhoc-signed builds that fail a
 *     bare child_process spawn under our daemon's process tree on macOS.
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
    // We can always resolve something (system Chrome → Playwright Chromium
    // auto-install → Camoufox auto-download); errors surface at acquire.
    return true;
  }

  async acquire(agentId: string): Promise<AcquiredBrowser> {
    if (!agentId) throw new Error("LocalChromeProvider.acquire requires an agentId");
    const existing = this.sessions.get(agentId);
    if (existing && this.isSessionAlive(existing)) {
      return this.handleFor(agentId, existing);
    }
    if (existing) {
      this.sessions.delete(agentId);
      await this.disposeSession(existing).catch(() => {});
    }
    const inflight = this.acquiring.get(agentId);
    if (inflight) return inflight;
    const p = this.spawnFor(agentId).finally(() => this.acquiring.delete(agentId));
    this.acquiring.set(agentId, p);
    return p;
  }

  private isSessionAlive(session: AgentSession): boolean {
    if (session.kind === "spawn") return session.running.proc.exitCode === null;
    // For context-based sessions, BrowserContext doesn't expose a tidy
    // is-alive bit. If the underlying browser is closed, calls fail and
    // BrowserManager invalidates the instance via its disconnected handler.
    return true;
  }

  private async spawnFor(agentId: string): Promise<AcquiredBrowser> {
    const resolved = await resolveLocalBinary({
      kind: this.cfg.localBrowser,
      executablePathOverride: this.cfg.executablePath,
      onProgress: (msg) => {
        console.log(`[browser/local] ${msg}`);
      },
    });
    const userDataDir = resolveUserDataDir(this.dataDir, agentId);

    if (resolved.kind === "context") {
      const context = await resolved.launch({ userDataDir, headless: this.cfg.headless });
      const session: ContextSession = { kind: "context", context };
      this.sessions.set(agentId, session);
      context.once("close", () => {
        if (this.sessions.get(agentId) === session) this.sessions.delete(agentId);
      });
      return this.handleFor(agentId, session);
    }

    const running = await launchChrome({
      exe: resolved.exe,
      userDataDir,
      headless: this.cfg.headless,
      noSandbox: this.cfg.noSandbox,
      extraArgs: resolved.extraArgs,
    });
    const session: SpawnedSession = { kind: "spawn", running };
    this.sessions.set(agentId, session);
    running.proc.once("exit", () => {
      if (this.sessions.get(agentId) === session) this.sessions.delete(agentId);
    });
    return this.handleFor(agentId, session);
  }

  private handleFor(agentId: string, session: AgentSession): AcquiredBrowser {
    if (session.kind === "context") {
      return {
        preBuiltContext: session.context,
        release: () => this.releaseAgent(agentId),
      };
    }
    return {
      cdpUrl: session.running.cdpUrl,
      release: () => this.releaseAgent(agentId),
    };
  }

  private async disposeSession(session: AgentSession): Promise<void> {
    if (session.kind === "context") {
      try {
        await session.context.close();
      } catch {
        // best-effort
      }
      return;
    }
    try {
      await killChrome(session.running);
    } catch {
      // best-effort
    }
  }

  async releaseAgent(agentId: string): Promise<void> {
    const s = this.sessions.get(agentId);
    if (!s) return;
    this.sessions.delete(agentId);
    await this.disposeSession(s);
  }

  async releaseAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.releaseAgent(id)));
  }
}
