import { WebRateLimitError } from "../types.js";
import {
  truncate,
  type ExtractOptions,
  type ExtractProvider,
  type ExtractResult,
} from "./types.js";

const BASE_URL = "https://r.jina.ai";

interface JinaResponse {
  code: number;
  status: number;
  data: {
    title?: string;
    description?: string;
    url?: string;
    content?: string;
    publishedTime?: string;
    metadata?: { lang?: string };
    warning?: string;
  };
}

export const jinaProvider: ExtractProvider = {
  id: "jina",
  async extract(opts: ExtractOptions, apiKey?: string): Promise<ExtractResult> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (opts.format === "html") {
      headers["x-return-format"] = "html";
    } else if (opts.format === "text") {
      headers["x-return-format"] = "text";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${BASE_URL}/${opts.url}`, {
        signal: controller.signal,
        headers,
      });

      if (response.status === 429) {
        throw new WebRateLimitError("jina", Boolean(apiKey));
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Jina ${response.status}: ${text || response.statusText}`);
      }

      const payload = (await response.json()) as JinaResponse;
      if (payload.code !== 200) {
        throw new Error(`Jina returned status ${payload.code}`);
      }

      const data = payload.data;
      const t = truncate((data.content ?? "").trim(), opts.maxChars);
      return {
        url: data.url ?? opts.url,
        provider: "jina",
        title: data.title,
        excerpt: data.description || undefined,
        lang: data.metadata?.lang,
        publishedDate: data.publishedTime,
        content: t.text,
        truncated: t.truncated,
        charsReturned: t.text.length,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
