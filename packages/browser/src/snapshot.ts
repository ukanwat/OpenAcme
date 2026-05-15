import type { Page } from "playwright-core";

export const SNAPSHOT_CHAR_CAP = 8000;
const TRUNCATION_FOOTER =
  "\n... truncated (interact then call browser_snapshot again)";

/**
 * Capture the page's aria-snapshot in the AI-optimized YAML-with-refs
 * format. Mode "ai" emits `[ref=eN]` markers resolvable via
 * `page.locator("aria-ref=eN")`. Verified against `playwright-core` 1.59
 * (`ariaSnapshot({ mode: "ai" })`).
 */
export async function ariaSnapshot(page: Page): Promise<string> {
  const text = await page.locator("body").ariaSnapshot({ mode: "ai" });
  if (text.length <= SNAPSHOT_CHAR_CAP) return text;
  const room = SNAPSHOT_CHAR_CAP - TRUNCATION_FOOTER.length;
  return text.slice(0, Math.max(0, room)) + TRUNCATION_FOOTER;
}
