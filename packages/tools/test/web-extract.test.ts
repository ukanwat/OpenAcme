import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractFromHtml } from "../src/web/extract/local.js";
import { resolveExtractProvider } from "../src/builtins/web-extract.js";
import { registry } from "../src/registry.js";

const ENV_KEYS = [
  "OPENACME_EXTRACT_PROVIDER",
  "OPENACME_EXTRACT_LOCAL",
  "FIRECRAWL_API_KEY",
  "JINA_API_KEY",
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

const SAMPLE = `<!doctype html>
<html lang="en">
<head><title>Sample Article</title></head>
<body>
  <header><nav>nav stuff</nav></header>
  <article>
    <h1>Sample Article</h1>
    <p class="byline">By Test Author</p>
    <p>This is the first paragraph of the article. It contains enough text for Readability to consider this the main content of the page, which it really needs.</p>
    <p>And here is the second paragraph with even more substantive content so that the heuristic clearly picks the article element over the navigation chrome.</p>
  </article>
  <footer>footer cruft</footer>
</body>
</html>`;

describe("extractFromHtml (local provider primitive)", () => {
  it("extracts main content as markdown by default", () => {
    const result = extractFromHtml(SAMPLE, "https://example.com/post", "markdown", 25_000);
    expect(result.title).toBe("Sample Article");
    expect(result.content).toContain("first paragraph");
    expect(result.content).not.toContain("nav stuff");
    expect(result.content).not.toContain("footer cruft");
    expect(result.truncated).toBe(false);
  });

  it("returns plain text when format=text", () => {
    const result = extractFromHtml(SAMPLE, "https://example.com/post", "text", 25_000);
    expect(result.content).toContain("first paragraph");
    expect(result.content).not.toContain("<");
  });

  it("truncates long output", () => {
    const result = extractFromHtml(SAMPLE, "https://example.com/post", "markdown", 50);
    expect(result.truncated).toBe(true);
    expect(result.charsReturned).toBe(50);
  });

  it("throws on unreadable HTML", () => {
    expect(() =>
      extractFromHtml("<html><body></body></html>", "https://example.com/", "markdown", 25_000),
    ).toThrow(/extract/);
  });
});

describe("resolveExtractProvider", () => {
  it("defaults to Jina when nothing is configured", () => {
    const r = resolveExtractProvider();
    if (typeof r === "string") throw new Error("unexpected error string");
    expect(r.provider.id).toBe("jina");
    expect(r.apiKey).toBeUndefined();
  });

  it("uses Jina with key when JINA_API_KEY is set", () => {
    process.env.JINA_API_KEY = "j";
    const r = resolveExtractProvider();
    if (typeof r === "string") throw new Error("unexpected error string");
    expect(r.provider.id).toBe("jina");
    expect(r.apiKey).toBe("j");
  });

  it("prefers Firecrawl when FIRECRAWL_API_KEY is set", () => {
    process.env.FIRECRAWL_API_KEY = "f";
    const r = resolveExtractProvider();
    if (typeof r === "string") throw new Error("unexpected error string");
    expect(r.provider.id).toBe("firecrawl");
    expect(r.apiKey).toBe("f");
  });

  it("uses local when OPENACME_EXTRACT_LOCAL=true", () => {
    process.env.OPENACME_EXTRACT_LOCAL = "true";
    process.env.FIRECRAWL_API_KEY = "f";
    const r = resolveExtractProvider();
    if (typeof r === "string") throw new Error("unexpected error string");
    expect(r.provider.id).toBe("local");
  });

  it("respects OPENACME_EXTRACT_PROVIDER explicitly", () => {
    process.env.OPENACME_EXTRACT_PROVIDER = "local";
    const r = resolveExtractProvider();
    if (typeof r === "string") throw new Error("unexpected error string");
    expect(r.provider.id).toBe("local");
  });

  it("errors if explicit Firecrawl is selected without a key", () => {
    process.env.OPENACME_EXTRACT_PROVIDER = "firecrawl";
    const r = resolveExtractProvider();
    expect(typeof r).toBe("string");
    expect(r as string).toMatch(/FIRECRAWL_API_KEY/);
  });

  it("errors on unknown explicit provider", () => {
    process.env.OPENACME_EXTRACT_PROVIDER = "bogus";
    const r = resolveExtractProvider();
    expect(typeof r).toBe("string");
    expect(r as string).toMatch(/not recognized/);
  });
});

describe("web_extract tool dispatch", () => {
  it("calls Jina by default and surfaces structured fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 200,
          status: 20000,
          data: {
            title: "Hello",
            url: "https://example.com/",
            content: "# Hello\n\nworld",
            metadata: { lang: "en" },
            publishedTime: "2026-05-08T00:00:00Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tool = registry.get("web_extract");
    const out = JSON.parse(
      await tool!.handler({ url: "https://example.com/", format: "markdown", maxChars: 25_000 }),
    ) as Record<string, unknown>;

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect((fetchSpy.mock.calls[0]![0] as string).startsWith("https://r.jina.ai/")).toBe(true);
    expect(out.success).toBe(true);
    expect(out.provider).toBe("jina");
    expect(out.title).toBe("Hello");
    expect(out.content).toContain("world");
  });

  it("calls Firecrawl when FIRECRAWL_API_KEY is set", async () => {
    process.env.FIRECRAWL_API_KEY = "fc-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            markdown: "# Title\n\nbody",
            metadata: { title: "Title", sourceURL: "https://example.com/", language: "en" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tool = registry.get("web_extract");
    const out = JSON.parse(
      await tool!.handler({ url: "https://example.com/", format: "markdown", maxChars: 25_000 }),
    ) as Record<string, unknown>;

    expect(fetchSpy.mock.calls[0]![0]).toBe("https://api.firecrawl.dev/v1/scrape");
    expect(out.success).toBe(true);
    expect(out.provider).toBe("firecrawl");
    expect(out.title).toBe("Title");
  });

  it("returns an educational message when Jina rate-limits unauthenticated calls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );

    const tool = registry.get("web_extract");
    const out = JSON.parse(
      await tool!.handler({ url: "https://example.com/", format: "markdown", maxChars: 25_000 }),
    ) as Record<string, unknown>;

    expect(out.error).toMatch(/rate-limited/);
    expect(out.error).toMatch(/JINA_API_KEY/);
    expect(out.error).toMatch(/FIRECRAWL_API_KEY/);
    expect(out.error).toMatch(/OPENACME_EXTRACT_LOCAL/);
  });

  it("uses local provider when OPENACME_EXTRACT_LOCAL=true", async () => {
    process.env.OPENACME_EXTRACT_LOCAL = "true";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(SAMPLE, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const tool = registry.get("web_extract");
    const out = JSON.parse(
      await tool!.handler({ url: "https://example.com/post", format: "markdown", maxChars: 25_000 }),
    ) as Record<string, unknown>;

    expect((fetchSpy.mock.calls[0]![0] as string).startsWith("https://r.jina.ai/")).toBe(false);
    expect(out.success).toBe(true);
    expect(out.provider).toBe("local");
    expect(out.title).toBe("Sample Article");
  });
});
