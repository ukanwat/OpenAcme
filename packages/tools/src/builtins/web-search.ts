import { z } from 'zod';
import { registry } from "../registry.js";
import { WebRateLimitError, type SearchProvider } from "../web/types.js";
import { tavilyProvider } from "../web/providers/tavily.js";
import { exaProvider } from "../web/providers/exa.js";
import { braveProvider } from "../web/providers/brave.js";

const PROVIDERS: Record<string, SearchProvider> = {
  tavily: tavilyProvider,
  exa: exaProvider,
  brave: braveProvider,
};

const PROVIDER_ENV: Record<string, string> = {
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_API_KEY",
};

interface ResolvedKey {
  provider: SearchProvider;
  apiKey?: string;
}

// Resolution order — always returns a usable provider:
//  1. Explicit OPENACME_SEARCH_PROVIDER (+ matching key, with Exa being key-optional)
//  2. OPENACME_SEARCH_API_KEY alone → Tavily (legacy)
//  3. TAVILY_API_KEY → Tavily
//  4. BRAVE_API_KEY → Brave
//  5. default → Exa MCP (authenticated if EXA_API_KEY is set, otherwise the
//     150/day unauthenticated free tier — same endpoint either way)
//
// Returns ResolvedKey | string: the string form is an error message for
// misconfigured explicit providers (e.g. PROVIDER=tavily but no key).
export function resolveSearchProvider(): ResolvedKey | string {
  const explicitProvider = process.env.OPENACME_SEARCH_PROVIDER;
  const explicitKey = process.env.OPENACME_SEARCH_API_KEY;

  if (explicitProvider) {
    const provider = PROVIDERS[explicitProvider];
    if (!provider) {
      return `OPENACME_SEARCH_PROVIDER='${explicitProvider}' is not recognized (use tavily, exa, or brave)`;
    }
    const key = explicitKey ?? process.env[PROVIDER_ENV[explicitProvider]!];
    if (!key && explicitProvider !== "exa") {
      return `OPENACME_SEARCH_PROVIDER=${explicitProvider} but no ${PROVIDER_ENV[explicitProvider]} or OPENACME_SEARCH_API_KEY is set`;
    }
    return { provider, apiKey: key };
  }

  if (explicitKey) {
    return { provider: PROVIDERS.tavily!, apiKey: explicitKey };
  }
  if (process.env.TAVILY_API_KEY) {
    return { provider: PROVIDERS.tavily!, apiKey: process.env.TAVILY_API_KEY };
  }
  if (process.env.BRAVE_API_KEY) {
    return { provider: PROVIDERS.brave!, apiKey: process.env.BRAVE_API_KEY };
  }
  return { provider: PROVIDERS.exa!, apiKey: process.env.EXA_API_KEY };
}

function rateLimitMessage(err: WebRateLimitError): string {
  const base = `Web search rate-limited by ${err.providerId} (HTTP 429).`;
  if (err.providerId === "exa" && !err.authed) {
    return `${base} The unauthenticated free tier is 150/day. Add EXA_API_KEY (1000/mo free at exa.ai) for higher limits, or set TAVILY_API_KEY (1000/mo free at tavily.com) to switch providers.`;
  }
  if (err.providerId === "exa") {
    return `${base} You've hit your Exa quota. Upgrade your plan, or set TAVILY_API_KEY / BRAVE_API_KEY to switch providers.`;
  }
  return `${base} Try again later or set EXA_API_KEY (free tier) to switch providers.`;
}

registry.register({
  name: "web_search",
  toolset: "web",
  description:
    "Search the web for up-to-date information. Returns {title, url, snippet} per result. " +
    "Works zero-config via Exa's free tier (150/day, IP-rate-limited). For higher limits, set " +
    "TAVILY_API_KEY (1000/mo free), BRAVE_API_KEY, or EXA_API_KEY (1000/mo free). " +
    "Override the provider explicitly via OPENACME_SEARCH_PROVIDER=tavily|exa|brave.",
  parameters: z.object({
    query: z.string().min(1).describe("Search query"),
    numResults: z
      .number()
      .min(1)
      .max(20)
      .optional()
      .default(5)
      .describe("How many results to return (1-20, default 5)"),
    freshness: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe("Limit results to content published within this window"),
    includeDomains: z
      .array(z.string())
      .optional()
      .describe("Restrict results to these domains"),
    excludeDomains: z
      .array(z.string())
      .optional()
      .describe("Exclude results from these domains"),
  }),
  emoji: "🔎",
  parallelSafe: true,
  handler: async (args) => {
    const params = args as {
      query: string;
      numResults: number;
      freshness?: "day" | "week" | "month" | "year";
      includeDomains?: string[];
      excludeDomains?: string[];
    };

    const resolved = resolveSearchProvider();
    if (typeof resolved === "string") {
      return JSON.stringify({ error: resolved });
    }

    try {
      const response = await resolved.provider.search(params, resolved.apiKey);
      return JSON.stringify({ success: true, ...response });
    } catch (error) {
      if (error instanceof WebRateLimitError) {
        return JSON.stringify({ error: rateLimitMessage(error) });
      }
      return JSON.stringify({
        error: `Search failed: ${(error as Error).message}`,
      });
    }
  },
});
