import {
  WebRateLimitError,
  type SearchOptions,
  type SearchProvider,
  type SearchResponse,
} from "../types.js";

const REST_ENDPOINT = "https://api.exa.ai/search";
const MCP_ENDPOINT = "https://mcp.exa.ai/mcp";

const FRESHNESS_MS: Record<NonNullable<SearchOptions["freshness"]>, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

interface ExaRestResult {
  title?: string;
  url?: string;
  text?: string;
  publishedDate?: string;
  score?: number;
}

async function searchViaRest(
  opts: SearchOptions,
  apiKey: string,
): Promise<SearchResponse> {
  const body: Record<string, unknown> = {
    query: opts.query,
    numResults: opts.numResults,
    type: "auto",
    contents: { text: { maxCharacters: 1000 } },
  };
  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains;
  if (opts.freshness) {
    body.startPublishedDate = new Date(
      Date.now() - FRESHNESS_MS[opts.freshness],
    ).toISOString();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(REST_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      throw new WebRateLimitError("exa", true);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Exa ${response.status}: ${text || response.statusText}`);
    }

    const data = (await response.json()) as { results?: ExaRestResult[] };
    return {
      query: opts.query,
      provider: "exa",
      results: (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.text ?? "",
        publishedDate: r.publishedDate,
        score: r.score,
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}

interface McpResponse {
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { message?: string };
}

async function searchViaMcp(opts: SearchOptions): Promise<SearchResponse> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query: opts.query,
        type: "auto",
        numResults: opts.numResults,
        livecrawl: "fallback",
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
    const response = await fetch(MCP_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      throw new WebRateLimitError("exa", false);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Exa MCP ${response.status}: ${text || response.statusText}`);
    }

    // The MCP endpoint streams a single SSE message with the JSON-RPC payload.
    // Walk the lines, parse the first valid `data: ...` chunk.
    const raw = await response.text();
    let payload: McpResponse | null = null;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        payload = JSON.parse(line.slice("data: ".length)) as McpResponse;
        break;
      } catch {
        continue;
      }
    }
    if (!payload) throw new Error("Exa MCP returned no parseable SSE message");
    if (payload.error) {
      throw new Error(`Exa MCP error: ${payload.error.message ?? "unknown"}`);
    }

    // Pass the LLM-formatted prose through verbatim. Exa returns one block per
    // result with Title/URL/Highlights — models read it fine; we don't try to
    // re-parse it back into structured fields.
    return {
      query: opts.query,
      provider: "exa",
      results: [],
      content: payload.result?.content?.[0]?.text ?? "",
    };
  } finally {
    clearTimeout(timer);
  }
}

export const exaProvider: SearchProvider = {
  id: "exa",
  search(opts: SearchOptions, apiKey?: string): Promise<SearchResponse> {
    return apiKey ? searchViaRest(opts, apiKey) : searchViaMcp(opts);
  },
};
