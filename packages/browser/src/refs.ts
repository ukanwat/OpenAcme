import type { Locator, Page } from "playwright-core";

/**
 * Resolve a snapshot ref (`e3`, `@e3`, `ref=e3`) to a Playwright Locator.
 * Uses Playwright's `aria-ref=` selector which is the stable counterpart to
 * the refs emitted by `Locator.ariaSnapshot({ ref: true })`.
 */
export function refLocator(page: Page, ref: string): Locator {
  const normalized = ref.startsWith("@")
    ? ref.slice(1)
    : ref.startsWith("ref=")
      ? ref.slice(4)
      : ref;
  return page.locator(`aria-ref=${normalized}`);
}
