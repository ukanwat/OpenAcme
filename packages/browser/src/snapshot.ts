import type { Page } from "playwright-core";

/**
 * Capture the page's aria-snapshot in the AI-optimized YAML-with-refs
 * format. Mode "ai" emits `[ref=eN]` markers resolvable via
 * `page.locator("aria-ref=eN")`. Verified against `playwright-core` 1.59.
 *
 * `selector` scopes the snapshot to a subtree (any Playwright locator
 * string, e.g. `form[data-testid="reply"]`, `role=main`). Lets the agent
 * bypass page chrome when the whole body is too noisy.
 *
 * No size cap here — the registry's spill-to-file wrapper catches big
 * results across every tool, so this can return the full tree and the
 * agent can grep / read_file against the spilled copy.
 */
export async function ariaSnapshot(
  page: Page,
  selector?: string
): Promise<string> {
  return page.locator(selector ?? "body").ariaSnapshot({ mode: "ai" });
}
