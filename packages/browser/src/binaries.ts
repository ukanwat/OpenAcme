import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { chromium } from "playwright-core";
import { findChromeExecutable } from "./chrome.js";

/**
 * The local-browser kind. "chromium" prefers a system Chrome / Brave /
 * Edge / Chromium install; if none is found, falls back to Playwright's
 * bundled Chromium (auto-downloaded on demand). "cloakbrowser" uses the
 * `cloakbrowser` npm package's binary — must be installed separately
 * because we don't ship its ~200MB binary by default.
 */
export type LocalBrowserKind = "chromium" | "cloakbrowser";

/**
 * Resolve the local browser binary to spawn. Caller is the
 * LocalChromeProvider; this stays pure (no spawning, no caching beyond
 * filesystem checks) so the provider keeps lifecycle control.
 *
 * `executablePathOverride` always wins so power users can point at any
 * Chromium-family binary regardless of the kind selection.
 */
export async function resolveLocalBinary(opts: {
  kind: LocalBrowserKind;
  executablePathOverride?: string;
  onProgress?: (msg: string) => void;
}): Promise<string> {
  if (opts.executablePathOverride) {
    if (!fs.existsSync(opts.executablePathOverride)) {
      throw new Error(`browser.executablePath does not exist: ${opts.executablePathOverride}`);
    }
    return opts.executablePathOverride;
  }
  if (opts.kind === "cloakbrowser") {
    return resolveCloakBrowserBinary();
  }
  return resolveChromiumBinary(opts.onProgress);
}

async function resolveChromiumBinary(onProgress?: (msg: string) => void): Promise<string> {
  // System install wins — user already paid the cost, and accounts they
  // logged into are reusable per agent profile.
  const systemPath = findChromeExecutable();
  if (systemPath) return systemPath;

  // Fall back to Playwright's bundled Chromium. `executablePath()` returns
  // the path Playwright EXPECTS even when the binary isn't downloaded yet.
  const pwPath = chromium.executablePath();
  if (pwPath && fs.existsSync(pwPath)) return pwPath;

  onProgress?.("Installing Chromium (one-time, ~120MB)…");
  await installPlaywrightChromium();
  const installedPath = chromium.executablePath();
  if (installedPath && fs.existsSync(installedPath)) return installedPath;

  throw new Error(
    "Failed to install Chromium. Run `npx playwright install chromium` manually, or set browser.executablePath."
  );
}

async function installPlaywrightChromium(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("npx", ["--no-install", "playwright", "install", "chromium"], {
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
      reject(
        new Error(
          `playwright install chromium failed (exit ${code}): ${stderr.slice(-500)}`
        )
      );
    });
  });
}

async function resolveCloakBrowserBinary(): Promise<string> {
  // Dynamic import so cloakbrowser stays optional — users who never pick
  // this kind don't pay the install / disk cost.
  let mod: unknown;
  try {
    mod = await import("cloakbrowser" as string);
  } catch {
    throw new Error(
      "CloakBrowser not installed. Run `pnpm add cloakbrowser` in the workspace, " +
        "then restart the daemon. The binary downloads (~200MB) on first import."
    );
  }
  const m = mod as { executablePath?: () => string | Promise<string> };
  if (typeof m.executablePath === "function") {
    const p = await m.executablePath();
    if (!p || !fs.existsSync(p)) {
      throw new Error(
        "CloakBrowser package is installed but its binary is missing. " +
          "Try `pnpm rebuild cloakbrowser` to trigger the download."
      );
    }
    return p;
  }
  throw new Error(
    "cloakbrowser package does not expose executablePath(). Check the version (need >=X) or set browser.executablePath manually."
  );
}
