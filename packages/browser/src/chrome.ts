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
  cdpPort: number;
  userDataDir: string;
  headless: boolean;
  noSandbox: boolean;
}): string[] {
  const args = [
    `--remote-debugging-port=${opts.cdpPort}`,
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
  return args;
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

export async function launchChrome(opts: {
  exe: string;
  cdpPort: number;
  userDataDir: string;
  headless: boolean;
  noSandbox: boolean;
}): Promise<RunningChrome> {
  fs.mkdirSync(opts.userDataDir, { recursive: true });
  clearStaleSingletonLocks(opts.userDataDir);

  const args = buildLaunchArgs(opts);
  const proc = spawn(opts.exe, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
    env: process.env,
  });

  let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  proc.once("exit", (code, signal) => {
    earlyExit = { code, signal };
  });

  // Wait for CDP — fail fast if Chrome dies during startup.
  try {
    const wsUrl = await Promise.race([
      pollForCdpReady({ cdpPort: opts.cdpPort, budgetMs: 15_000 }),
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
      }),
    ]);
    return {
      proc,
      cdpPort: opts.cdpPort,
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

export function resolveUserDataDir(dataDir: string): string {
  return path.join(dataDir, "browser-profile");
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
