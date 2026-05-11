import type { Browser } from "playwright-core";
import { chromium } from "playwright-core";

/**
 * Connect Playwright to a running Chrome via CDP, with retry + in-flight
 * dedup. The caller owns the cache — pass `null` for a fresh attempt.
 *
 * Mirrors openclaw's connectBrowser: 3 attempts with backoff, registers
 * a `disconnected` listener so the cache can self-invalidate.
 */
export async function connectOverCdp(opts: {
  wsUrl: string;
  onDisconnected: (browser: Browser) => void;
}): Promise<Browser> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const browser = await chromium.connectOverCDP(opts.wsUrl, {
        timeout: 5000 + attempt * 2000,
      });
      browser.on("disconnected", () => opts.onDisconnected(browser));
      return browser;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 + attempt * 250));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`connectOverCDP failed: ${String(lastErr)}`);
}

const RECOVERABLE_PATTERNS = [
  "target page, context or browser has been closed",
  "browser has been closed",
  "browser disconnected",
  "target closed",
  "connection closed",
  "websocket closed",
  "cdp socket closed",
];

/** True when the error looks like a transient CDP disconnect that we can
 *  recover from by reconnecting and retrying once. */
export function isRecoverableDisconnect(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return RECOVERABLE_PATTERNS.some((p) => msg.includes(p));
}
