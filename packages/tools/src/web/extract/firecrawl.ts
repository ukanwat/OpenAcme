import { WebRateLimitError } from "../types.js";
import {
  truncate,
  type ExtractOptions,
  type ExtractProvider,
  type ExtractResult,
} from "./types.js";

const ENDPOINT = "https://api.firecrawl.dev/v1/scrape";

interface FirecrawlResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    html?: string;
    rawHtml?: string;
    // Firecrawl returns meta-tag values as either a string or an array of
    // strings (when multiple matching tags exist on the page).
    metadata?: {
      title?: string | string[];
      description?: string | string[];
      sourceURL?: string;
      language?: string | string[];
      author?: string | string[];
      publishedTime?: string | string[];
    };
  };
  error?: string;
}

function firstString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export const firecrawlProvider: ExtractProvider = {
  id: "firecrawl",
  async extract(opts: ExtractOptions, apiKey?: string): Promise<ExtractResult> {
    if (!apiKey) {
      throw new Error("Firecrawl requires FIRECRAWL_API_KEY");
    }

    // Firecrawl returns either markdown or html — there is no native plain-text
    // mode. For a text request we serve markdown (effectively LLM-readable
    // plain text) and the response includes the actual format the caller got.
    const formats = opts.format === "html" ? ["html"] : ["markdown"];
    const effectiveFormat: "markdown" | "html" = opts.format === "html" ? "html" : "markdown";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          url: opts.url,
          formats,
          onlyMainContent: true,
        }),
      });

      if (response.status === 429) {
        throw new WebRateLimitError("firecrawl", true);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Firecrawl ${response.status}: ${text || response.statusText}`);
      }

      const payload = (await response.json()) as FirecrawlResponse;
      if (!payload.success || !payload.data) {
        throw new Error(`Firecrawl: ${payload.error ?? "unknown error"}`);
      }

      const data = payload.data;
      const body = effectiveFormat === "html" ? (data.html ?? "") : (data.markdown ?? data.html ?? "");
      const t = truncate(body.trim(), opts.maxChars);
      const meta = data.metadata ?? {};

      return {
        url: meta.sourceURL ?? opts.url,
        provider: "firecrawl",
        format: effectiveFormat,
        title: firstString(meta.title),
        byline: firstString(meta.author),
        excerpt: firstString(meta.description),
        lang: firstString(meta.language),
        publishedDate: firstString(meta.publishedTime),
        content: t.text,
        truncated: t.truncated,
        charsReturned: t.text.length,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
