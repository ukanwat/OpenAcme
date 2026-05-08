import {
  WebRateLimitError,
  type SearchOptions,
  type SearchProvider,
  type SearchResponse,
} from "../types.js";

const ENDPOINT = "https://api.tavily.com/search";

function freshnessToDays(f: SearchOptions["freshness"]): number | undefined {
  switch (f) {
    case "day":
      return 1;
    case "week":
      return 7;
    case "month":
      return 30;
    case "year":
      return 365;
    default:
      return undefined;
  }
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
}

export const tavilyProvider: SearchProvider = {
  id: "tavily",
  async search(opts: SearchOptions, apiKey?: string): Promise<SearchResponse> {
    if (!apiKey) {
      throw new Error("Tavily requires TAVILY_API_KEY");
    }
    const days = freshnessToDays(opts.freshness);
    // search_depth=basic costs 1 Tavily credit; "advanced" costs 2 and halves
    // a user's free-tier monthly quota (1000 → 500). Stick with basic for
    // routine agent queries; users wanting deeper research can configure
    // OPENACME_TAVILY_SEARCH_DEPTH=advanced (read at call time).
    const depth =
      process.env.OPENACME_TAVILY_SEARCH_DEPTH === "advanced" ? "advanced" : "basic";
    const body: Record<string, unknown> = {
      api_key: apiKey,
      query: opts.query,
      max_results: opts.numResults,
      search_depth: depth,
    };
    if (days) body.days = days;
    if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
    if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (response.status === 429) {
        throw new WebRateLimitError("tavily", true);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Tavily ${response.status}: ${text || response.statusText}`);
      }

      const data = (await response.json()) as { results?: TavilyResult[] };
      const results = (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
        publishedDate: r.published_date,
        score: r.score,
      }));

      return { query: opts.query, provider: "tavily", results };
    } finally {
      clearTimeout(timer);
    }
  },
};
