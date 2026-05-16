import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { BrowserConfig } from "./types.js";

export interface RunningChrome {
  proc: ChildProcess;
  cdpPort: number;
  cdpUrl: string;
  userDataDir: string;
}

const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/**
 * Resolve a Chrome-family executable for the current platform. Mirrors
 * openclaw's per-platform search order: Chrome → Brave → Edge → Chromium.
 */
export function findChromeExecutable(override?: string): string | null {
  if (override && fs.existsSync(override)) return override;

  const platform = process.platform;
  if (platform === "darwin") {
    const macCandidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    return macCandidates.find((p) => fs.existsSync(p)) ?? null;
  }
  if (platform === "linux") {
    const linuxNames = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "brave-browser",
      "microsoft-edge",
    ];
    const paths = (process.env.PATH ?? "").split(":");
    for (const name of linuxNames) {
      for (const dir of paths) {
        if (!dir) continue;
        const full = path.join(dir, name);
        try {
          if (fs.existsSync(full)) return full;
        } catch {
          // ignore
        }
      }
    }
    return null;
  }
  if (platform === "win32") {
    const winCandidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ];
    return winCandidates.find((p) => fs.existsSync(p)) ?? null;
  }
  return null;
}

export function chromeInstallHint(): string {
  switch (process.platform) {
    case "darwin":
      return "Install Google Chrome from https://www.google.com/chrome/ — or set browser.executablePath in config.";
    case "linux":
      return "Install with: apt-get install google-chrome-stable  OR  apt-get install chromium  OR set browser.executablePath.";
    case "win32":
      return "Install Google Chrome from https://www.google.com/chrome/ — or set browser.executablePath in config.";
    default:
      return "Set browser.executablePath in config to a Chrome / Brave / Edge / Chromium binary.";
  }
}

/**
 * Clean up stale Chrome singleton lock files left behind by a crashed
 * Chrome instance. Mirrors openclaw's logic: read the SingletonLock symlink
 * target (`host-pid` format); if pid is dead on this host, the lock files
 * are removed. Returns true if any cleanup happened.
 */
export function clearStaleSingletonLocks(userDataDir: string): boolean {
  const lockPath = path.join(userDataDir, "SingletonLock");
  let target: string;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return false;
  }
  const match = /^(?<host>.+)-(?<pid>\d+)$/.exec(target);
  if (!match?.groups) return false;
  const lockHost = match.groups.host ?? "";
  const pid = Number.parseInt(match.groups.pid ?? "", 10);
  if (lockHost === os.hostname() && processExists(pid)) {
    // Lock is still held by a live Chrome on this host — don't touch.
    return false;
  }
  for (const f of SINGLETON_FILES) {
    try {
      fs.rmSync(path.join(userDataDir, f), { force: true });
    } catch {
      // best-effort
    }
  }
  return true;
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

export function buildLaunchArgs(opts: {
  userDataDir: string;
  headless: boolean;
  noSandbox: boolean;
  /** Extra args from the binary's wrapper (e.g. CloakBrowser stealth flags). */
  extraArgs?: string[];
}): string[] {
  // Port 0 → Chrome picks an ephemeral one and writes it to
  // <userDataDir>/DevToolsActivePort. Lets us run N agents in parallel
  // without coordinating port assignment.
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--password-store=basic",
    "--no-proxy-server",
  ];
  if (opts.headless) {
    args.push("--headless=new", "--disable-gpu");
  }
  if (opts.noSandbox) {
    args.push("--no-sandbox");
  }
  if (process.platform === "linux") {
    args.push("--disable-dev-shm-usage");
  }
  if (opts.extraArgs?.length) {
    // Append + dedupe by flag-name (everything before the first `=`). Later
    // entries (extra args) win — wrapper-specific flags can override our
    // generic defaults.
    const seen = new Map<string, string>(
      args.map((a) => [a.split("=")[0] ?? a, a])
    );
    for (const a of opts.extraArgs) {
      seen.set(a.split("=")[0] ?? a, a);
    }
    return Array.from(seen.values());
  }
  return args;
}

/**
 * Read the port Chrome wrote to <userDataDir>/DevToolsActivePort. The file
 * has two lines: `<port>\n/devtools/browser/<uuid>`. Polled because Chrome
 * writes it some milliseconds after we spawn the process.
 */
export async function readDevToolsActivePort(opts: {
  userDataDir: string;
  budgetMs: number;
}): Promise<number> {
  const filePath = path.join(opts.userDataDir, "DevToolsActivePort");
  const start = Date.now();
  while (Date.now() - start < opts.budgetMs) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const firstLine = raw.split("\n", 1)[0]?.trim();
      const port = firstLine ? Number.parseInt(firstLine, 10) : NaN;
      if (Number.isInteger(port) && port > 0 && port < 65_536) return port;
    } catch {
      // File not written yet
    }
    await sleep(50);
  }
  throw new Error(
    `Chrome did not write DevToolsActivePort to ${filePath} within ${opts.budgetMs}ms`
  );
}

/**
 * Poll /json/version until Chrome's CDP is up. Returns the
 * `webSocketDebuggerUrl` advertised by Chrome.
 */
export async function pollForCdpReady(opts: {
  cdpPort: number;
  budgetMs: number;
}): Promise<string> {
  const start = Date.now();
  const versionUrl = `http://127.0.0.1:${opts.cdpPort}/json/version`;
  let lastErr: unknown = null;
  while (Date.now() - start < opts.budgetMs) {
    try {
      const res = await fetch(versionUrl);
      if (res.ok) {
        const payload = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (payload.webSocketDebuggerUrl) return payload.webSocketDebuggerUrl;
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(100);
  }
  throw new Error(
    `Chrome CDP did not become ready on port ${opts.cdpPort} within ${opts.budgetMs}ms` +
      (lastErr instanceof Error ? `: ${lastErr.message}` : "")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Strip env vars that confuse a child Chromium's launch on macOS:
 *   - `__CFBundleIdentifier` is inherited from the parent .app bundle and
 *     trips the hardened-runtime check on adhoc-signed Chromium forks
 *     (CloakBrowser, patched Chromium). The child aborts with SIGTRAP at
 *     dyld init time. macOS expects the child to own its bundle ID.
 *   - `DYLD_*` are stripped by the loader for hardened binaries anyway,
 *     but a few Apple-internal variants can still cause warnings or
 *     unexpected behavior; cleanest to drop them here.
 *   - `MallocNanoZone=0` disables the Nano malloc zone — some allocators
 *     in patched Chromium builds assume it's enabled and abort otherwise.
 */
function sanitizeChromeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "darwin") return env;
  // Strip env vars that confuse a child Chromium on macOS:
  //   - `__CFBundleIdentifier` inherited from a parent .app bundle confuses
  //     Launch Services about who the child is.
  //   - `DYLD_*` is stripped by the loader for hardened binaries anyway;
  //     dropping it here avoids inherited overrides from dev tooling.
  //   - `MallocNanoZone=0` disables the Nano malloc some Chromium builds
  //     assume is on.
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "__CFBundleIdentifier") continue;
    if (k.startsWith("DYLD_")) continue;
    if (k === "MallocNanoZone" && v === "0") continue;
    cleaned[k] = v;
  }
  return cleaned;
}

export async function launchChrome(opts: {
  exe: string;
  userDataDir: string;
  headless: boolean;
  noSandbox: boolean;
  extraArgs?: string[];
}): Promise<RunningChrome> {
  fs.mkdirSync(opts.userDataDir, { recursive: true });
  clearStaleSingletonLocks(opts.userDataDir);
  // Pre-existing DevToolsActivePort would confuse the port reader below;
  // Chrome rewrites this file on its own boot, but only after a delay.
  try {
    fs.rmSync(path.join(opts.userDataDir, "DevToolsActivePort"), { force: true });
  } catch {
    // best-effort
  }

  const args = buildLaunchArgs(opts);
  const proc = spawn(opts.exe, args, {
    // Piped stderr WITH a drain — without the drain, the 64KB OS buffer
    // fills and chatty Chromium builds (CloakBrowser, patched forks) block
    // on stderr writes and stop servicing CDP.
    stdio: ["ignore", "ignore", "pipe"],
    // Own process group — keeps Chromium alive across our parent's signal
    // handling. unref below; BrowserManager owns shutdown via killChrome().
    detached: true,
    env: sanitizeChromeEnv(process.env),
  });
  proc.unref();
  proc.stderr?.on("data", () => {
    // Drain only — without a reader the 64KB OS buffer fills and Chrome
    // blocks on writes (some patched forks log heavily on startup).
  });

  let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  proc.once("exit", (code, signal) => {
    earlyExit = { code, signal };
  });

  const earlyExitWatcher = (): Promise<never> =>
    new Promise<never>((_, reject) => {
      const id = setInterval(() => {
        if (earlyExit) {
          clearInterval(id);
          reject(
            new Error(
              `Chrome exited during startup (code=${earlyExit.code} signal=${earlyExit.signal})`
            )
          );
        }
      }, 100);
    });

  try {
    const cdpPort = await Promise.race([
      readDevToolsActivePort({ userDataDir: opts.userDataDir, budgetMs: 10_000 }),
      earlyExitWatcher(),
    ]);
    const wsUrl = await Promise.race([
      pollForCdpReady({ cdpPort, budgetMs: 15_000 }),
      earlyExitWatcher(),
    ]);
    return {
      proc,
      cdpPort,
      cdpUrl: wsUrl,
      userDataDir: opts.userDataDir,
    };
  } catch (e) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    throw e;
  }
}

export async function killChrome(running: RunningChrome): Promise<void> {
  if (running.proc.exitCode !== null || running.proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    running.proc.once("exit", done);
    running.proc.once("close", done);
    try {
      running.proc.kill("SIGTERM");
    } catch {
      done();
      return;
    }
    setTimeout(() => {
      try {
        if (running.proc.exitCode === null && running.proc.signalCode === null) {
          running.proc.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
      done();
    }, 3000);
  });
}

export function resolveUserDataDir(dataDir: string, agentId: string): string {
  if (!agentId) throw new Error("resolveUserDataDir requires an agentId");
  return path.join(dataDir, "agents", agentId, "browser-profile");
}

export function resolveExecutableOrThrow(config: BrowserConfig): string {
  const exe = findChromeExecutable(config.executablePath);
  if (!exe) {
    throw new Error(
      `No Chrome / Brave / Edge / Chromium binary found. ${chromeInstallHint()}`
    );
  }
  return exe;
}
