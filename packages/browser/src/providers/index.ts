import type { BrowserConfig } from "../types.js";
import type { BrowserProvider } from "./base.js";
import { BrowserUseProvider } from "./browser-use.js";
import { BrowserbaseProvider } from "./browserbase.js";
import { FirecrawlProvider } from "./firecrawl.js";
import { LocalChromeProvider } from "./local.js";

export type { AcquiredBrowser, BrowserProvider } from "./base.js";
export { LocalChromeProvider } from "./local.js";
export { BrowserbaseProvider } from "./browserbase.js";
export { BrowserUseProvider } from "./browser-use.js";
export { FirecrawlProvider } from "./firecrawl.js";

export const PROVIDER_NAMES = ["local", "browserbase", "browser-use", "firecrawl"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * Build the provider chosen in `config.browser.provider`. Cloud providers
 * read credentials from env at acquire time; LocalChromeProvider needs the
 * dataDir to resolve per-agent user-data-dirs.
 */
export function createBrowserProvider(opts: {
  name: ProviderName;
  dataDir: string;
  config: BrowserConfig;
}): BrowserProvider {
  switch (opts.name) {
    case "local":
      return new LocalChromeProvider({ dataDir: opts.dataDir, config: opts.config });
    case "browserbase":
      return new BrowserbaseProvider();
    case "browser-use":
      return new BrowserUseProvider();
    case "firecrawl":
      return new FirecrawlProvider();
  }
}
