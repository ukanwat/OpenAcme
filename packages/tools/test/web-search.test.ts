import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveSearchProvider } from "../src/builtins/web-search.js";
import { registry } from "../src/registry.js";

const ENV_KEYS = [
  "OPENACME_SEARCH_API_KEY",
  "OPENACME_SEARCH_PROVIDER",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "BRAVE_API_KEY",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("resolveSearchProvider", () => {
  it("defaults to Exa (unauthenticated MCP) when no key is set", () => {
    const r = resolveSearchProvider();
    expect(r).not.toBeTypeOf("string");
    if (typeof r === "string") throw new Error("unexpected error string");
    expect(r.provider.id).toBe("exa");
    expect(r.apiKey).toBeUndefined();
  });

  it("uses Exa with key when EXA_API_KEY is set", () => {
    process.env.EXA_API_KEY = "exa-key";
    const r = resolveSearchProvider();
    if (typeof r === "string") throw new Error("unexpected error string");
    expect(r.provider.id).toBe("exa");
    expect(r.apiKey).toBe("exa-key");
  });

  it("prefers Tavily over the Exa default when TAVILY_API_KEY is set", () => {
    process.env.TAVILY_API_KEY = "t";
    const r = resolveSearchProvider();
    if (typeof r === "string") throw new Error("unexpected error string");
    expect(r.provider.id).toBe("tavily");
    expect(r.apiKey).toBe("t");
  });

  it("prefers Brave over the Exa default when BRAVE_API_KEY is set", () => {
    process.env.BRAVE_API_KEY = "b";
    const r = resolveSearchProvider();
    if (typeof r === "string") throw new Error("unexpected error string");
    expect(r.provider.id).toBe("brave");
  });

  it("respects OPENACME_SEARCH_PROVIDER explicitly", () => {
    process.env.OPENACME_SEARCH_PROVIDER = "exa";
    process.env.OPENACME_SEARCH_API_KEY = "k";
    const r = resolveSearchProvider();
    if (typeof r === "string") throw new Error("unexpected error string");
    expect(r.provider.id).toBe("exa");
    expect(r.apiKey).toBe("k");
  });

  it("returns an error string when explicit provider has no key", () => {
    process.env.OPENACME_SEARCH_PROVIDER = "tavily";
    const r = resolveSearchProvider();
    expect(typeof r).toBe("string");
    expect(r as string).toMatch(/no TAVILY_API_KEY/);
  });

  it("allows explicit Exa with no key (MCP fallback)", () => {
    process.env.OPENACME_SEARCH_PROVIDER = "exa";
    const r = resolveSearchProvider();
    if (typeof r === "string") throw new Error("unexpected error string");
    expect(r.provider.id).toBe("exa");
    expect(r.apiKey).toBeUndefined();
  });

  it("returns an error string for an unknown explicit provider", () => {
    process.env.OPENACME_SEARCH_PROVIDER = "duckduckgo";
    const r = resolveSearchProvider();
    expect(typeof r).toBe("string");
    expect(r as string).toMatch(/not recognized/);
  });
});

describe("web_search tool", () => {
  it("is always exposed (no checkFn)", () => {
    const tool = registry.get("web_search");
    expect(tool).toBeDefined();
    expect(tool?.checkFn).toBeUndefined();
  });

  it("calls Tavily REST and normalizes results", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Hello",
              url: "https://example.com",
              content: "snippet",
              score: 0.9,
              published_date: "2026-01-01",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tool = registry.get("web_search");
    const out = JSON.parse(
      await tool!.handler({ query: "hi", numResults: 1 }),
    ) as Record<string, unknown>;

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(out.success).toBe(true);
    expect(out.provider).toBe("tavily");
    expect((out.results as Array<{ title: string }>)[0]!.title).toBe("Hello");
  });

  it("calls Exa REST when EXA_API_KEY is set and returns structured results", async () => {
    process.env.EXA_API_KEY = "exa-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Doc",
              url: "https://docs.example.com",
              text: "Some text",
              publishedDate: "2026-02-01",
              score: 0.8,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tool = registry.get("web_search");
    const out = JSON.parse(
      await tool!.handler({ query: "hi", numResults: 1 }),
    ) as Record<string, unknown>;

    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("https://api.exa.ai/search");
    expect(out.success).toBe(true);
    expect((out.results as Array<{ title: string }>)[0]!.title).toBe("Doc");
  });

  it("calls Exa MCP unauthenticated by default and passes the text blob through", async () => {
    const sseBody = `event: message\ndata: ${JSON.stringify({
      result: {
        content: [{ type: "text", text: "Title: Hello\nURL: https://example.com\nHighlights:\n..." }],
      },
      jsonrpc: "2.0",
      id: 1,
    })}\n`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const tool = registry.get("web_search");
    const out = JSON.parse(
      await tool!.handler({ query: "hi", numResults: 1 }),
    ) as Record<string, unknown>;

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]![0]).toBe("https://mcp.exa.ai/mcp");
    expect(out.success).toBe(true);
    expect(out.provider).toBe("exa");
    expect(out.results).toEqual([]);
    expect(out.content).toContain("Title: Hello");
  });

  it("returns an educational message when the unauthenticated Exa free tier rate-limits", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );

    const tool = registry.get("web_search");
    const out = JSON.parse(
      await tool!.handler({ query: "hi", numResults: 1 }),
    ) as Record<string, unknown>;

    expect(out.error).toMatch(/rate-limited/);
    expect(out.error).toMatch(/EXA_API_KEY/);
    expect(out.error).toMatch(/TAVILY_API_KEY/);
  });

  it("surfaces a generic error for non-429 provider failures", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream is down", { status: 500 }),
    );

    const tool = registry.get("web_search");
    const out = JSON.parse(
      await tool!.handler({ query: "hi", numResults: 1 }),
    ) as Record<string, unknown>;

    expect(out.error).toMatch(/Search failed/);
    expect(out.error).toMatch(/Tavily 500/);
  });
});
