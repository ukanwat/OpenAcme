import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { chromium } from "playwright-core";
import type { BrowserContext } from "playwright-core";
import { findChromeExecutable } from "./chrome.js";

interface CamoufoxJs {
  launchOptions?: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Returns the cache dir Camoufox uses on the current platform. */
  getCacheDir?: () => string;
}

let cachedCamoufoxMod: CamoufoxJs | null = null;
async function loadCamoufoxJs(): Promise<CamoufoxJs> {
  if (cachedCamoufoxMod) return cachedCamoufoxMod;
  try {
    cachedCamoufoxMod = (await import("camoufox-js" as string)) as CamoufoxJs;
    return cachedCamoufoxMod;
  } catch {
    throw new Error(
      "Camoufox not installed. The host environment is missing the `camoufox-js` package."
    );
  }
}

/**
 * The local-browser kind. "chromium" prefers a system Chrome / Brave /
 * Edge / Chromium install; if none is found, falls back to Playwright's
 * bundled Chromium (auto-downloaded on demand). "camoufox" uses the
 * `camoufox-js` package's Firefox-based stealth browser via Playwright's
 * launchPersistentContext API.
 */
export type LocalBrowserKind = "chromium" | "camoufox";

/**
 * Resolved Chromium-family binary spawnable directly via launchChrome.
 * Used for the "chromium" kind and the executablePath override.
 */
export interface SpawnableBinary {
  kind: "spawn";
  exe: string;
  /** Extra CLI args required by the binary (none for stock Chromium). */
  extraArgs: string[];
}

/**
 * A factory that produces a Playwright-managed BrowserContext. Used for
 * Camoufox, whose Firefox-based binary doesn't speak CDP at all — we go
 * through Playwright's firefox.launchPersistentContext path. Bypassing the
 * manager's CDP attach is also what makes this resilient to the macOS
 * hardened-runtime traps that block bare-child-process spawns of
 * adhoc-signed browsers.
 */
export interface ContextLaunchable {
  kind: "context";
  launch(opts: { userDataDir: string; headless: boolean }): Promise<BrowserContext>;
}

export type ResolvedLocalBinary = SpawnableBinary | ContextLaunchable;

export async function resolveLocalBinary(opts: {
  kind: LocalBrowserKind;
  executablePathOverride?: string;
  onProgress?: (msg: string) => void;
}): Promise<ResolvedLocalBinary> {
  if (opts.executablePathOverride) {
    if (!fs.existsSync(opts.executablePathOverride)) {
      throw new Error(`browser.executablePath does not exist: ${opts.executablePathOverride}`);
    }
    return { kind: "spawn", exe: opts.executablePathOverride, extraArgs: [] };
  }
  if (opts.kind === "camoufox") {
    return resolveCamoufoxLauncher(opts.onProgress);
  }
  return resolveChromiumSpawnable(opts.onProgress);
}

async function resolveChromiumSpawnable(
  onProgress?: (msg: string) => void
): Promise<SpawnableBinary> {
  const systemPath = findChromeExecutable();
  if (systemPath) return { kind: "spawn", exe: systemPath, extraArgs: [] };

  const pwPath = chromium.executablePath();
  if (pwPath && fs.existsSync(pwPath)) return { kind: "spawn", exe: pwPath, extraArgs: [] };

  onProgress?.("Installing Chromium (one-time, ~120MB)…");
  await runNpx(["--no-install", "playwright", "install", "chromium"]);
  const installedPath = chromium.executablePath();
  if (installedPath && fs.existsSync(installedPath)) {
    return { kind: "spawn", exe: installedPath, extraArgs: [] };
  }
  throw new Error(
    "Failed to install Chromium. Run `npx playwright install chromium` manually, or set browser.executablePath."
  );
}

async function resolveCamoufoxLauncher(
  onProgress?: (msg: string) => void
): Promise<ContextLaunchable> {
  const m = await loadCamoufoxJs();
  if (typeof m.launchOptions !== "function") {
    throw new Error(
      "camoufox-js does not expose launchOptions(); package version is unsupported."
    );
  }
  if (!isCamoufoxInstalled(m)) {
    onProgress?.("Installing Camoufox (one-time, ~300MB)…");
    await runNpx(["--no-install", "camoufox-js", "fetch"]);
  }
  return {
    kind: "context",
    async launch({ userDataDir, headless }) {
      const { firefox } = await import("playwright-core");
      const options = await m.launchOptions!({ headless });
      return firefox.launchPersistentContext(userDataDir, options);
    },
  };
}

/**
 * True when the Camoufox binary is already fetched. Cheap (file stat).
 * Uses camoufox-js's own cache-dir resolver so the path stays correct on
 * Linux / Windows where the platform default differs. If the package
 * isn't importable yet, treat as not-installed so callers can decide
 * whether to attempt a fetch.
 */
export function isCamoufoxInstalled(mod?: CamoufoxJs): boolean {
  const m = mod ?? cachedCamoufoxMod;
  if (!m || typeof m.getCacheDir !== "function") return false;
  return fs.existsSync(`${m.getCacheDir()}/version.json`);
}

let camoufoxPrefetchInFlight: Promise<void> | null = null;

/**
 * Kick off a Camoufox binary download if not already installed. Idempotent —
 * concurrent callers share one in-flight promise. Fire-and-forget from the
 * caller's perspective; errors are swallowed so a failed prefetch doesn't
 * crash the server (the binary just downloads later on first agent use).
 */
export async function prefetchCamoufox(): Promise<void> {
  // loadCamoufoxJs is idempotent and cached; needed so isCamoufoxInstalled
  // can ask the package for its own cache dir.
  await loadCamoufoxJs().catch(() => {});
  if (isCamoufoxInstalled()) return;
  if (camoufoxPrefetchInFlight) return camoufoxPrefetchInFlight;
  camoufoxPrefetchInFlight = runNpx(["--no-install", "camoufox-js", "fetch"])
    .catch(() => {
      // best-effort; agent's first browser_navigate will retry
    })
    .finally(() => {
      camoufoxPrefetchInFlight = null;
    });
  return camoufoxPrefetchInFlight;
}

/** True while a prefetch is running — surfaced in /api/browser. */
export function isCamoufoxPrefetching(): boolean {
  return camoufoxPrefetchInFlight !== null;
}

async function runNpx(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("npx", args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`npx ${args.join(" ")} failed (exit ${code}): ${stderr.slice(-500)}`));
    });
  });
}
