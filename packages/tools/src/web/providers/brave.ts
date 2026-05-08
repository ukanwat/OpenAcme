import {
  WebRateLimitError,
  type SearchOptions,
  type SearchProvider,
  type SearchResponse,
} from "../types.js";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

function freshnessToParam(f: SearchOptions["freshness"]): string | undefined {
  switch (f) {
    case "day":
      return "pd";
    case "week":
      return "pw";
    case "month":
      return "pm";
    case "year":
      return "py";
    default:
      return undefined;
  }
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

export const braveProvider: SearchProvider = {
  id: "brave",
  async search(opts: SearchOptions, apiKey?: string): Promise<SearchResponse> {
    if (!apiKey) {
      throw new Error("Brave requires BRAVE_API_KEY");
    }
    const params = new URLSearchParams({
      q: opts.query,
      count: String(Math.min(opts.numResults, 20)),
    });
    const freshness = freshnessToParam(opts.freshness);
    if (freshness) params.set("freshness", freshness);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(`${ENDPOINT}?${params}`, {
        signal: controller.signal,
        headers: {
          "x-subscription-token": apiKey,
          accept: "application/json",
        },
      });

      if (response.status === 429) {
        throw new WebRateLimitError("brave", true);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Brave ${response.status}: ${text || response.statusText}`);
      }

      const data = (await response.json()) as {
        web?: { results?: BraveResult[] };
      };
      const results = (data.web?.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
        publishedDate: r.age,
      }));

      return { query: opts.query, provider: "brave", results };
    } finally {
      clearTimeout(timer);
    }
  },
};
