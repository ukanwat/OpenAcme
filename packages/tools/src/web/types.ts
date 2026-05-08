export interface SearchOptions {
  query: string;
  numResults: number;
  freshness?: "day" | "week" | "month" | "year";
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  score?: number;
}

export interface SearchResponse {
  query: string;
  provider: string;
  results: SearchResultItem[];
  // Some providers (Exa MCP) return an LLM-formatted text blob in addition to
  // (or instead of) structured results. Populated only when the provider's
  // response shape is text-first.
  content?: string;
}

export class WebRateLimitError extends Error {
  readonly providerId: string;
  readonly authed: boolean;
  constructor(providerId: string, authed: boolean) {
    super(`${providerId} rate limit (HTTP 429)`);
    this.name = "WebRateLimitError";
    this.providerId = providerId;
    this.authed = authed;
  }
}

export interface SearchProvider {
  readonly id: string;
  // apiKey is optional for providers that support unauthenticated calls (Exa MCP).
  search(opts: SearchOptions, apiKey?: string): Promise<SearchResponse>;
}
