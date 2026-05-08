import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import {
  truncate,
  type ExtractFormat,
  type ExtractOptions,
  type ExtractProvider,
  type ExtractResult,
} from "./types.js";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// First attempt uses a real-browser UA — many sites 403 anything that looks
// like a bot. Second attempt (only on Cloudflare's "challenge" mitigation)
// uses the bare brand name "OpenAcme" — some CF rule sets allowlist short
// declared identifiers as a way for known bots to opt in.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const FALLBACK_UA = "OpenAcme";

export function extractFromHtml(
  html: string,
  url: string,
  format: ExtractFormat,
  maxChars: number,
): ExtractResult {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();

  if (!article || !article.content) {
    throw new Error("Could not extract readable content from this page");
  }

  let body: string;
  if (format === "html") {
    body = article.content;
  } else if (format === "text") {
    body = article.textContent ?? "";
  } else {
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    body = td.turndown(article.content);
  }

  const t = truncate(body.trim(), maxChars);

  return {
    url,
    provider: "local",
    title: article.title ?? undefined,
    byline: article.byline ?? undefined,
    lang: article.lang ?? undefined,
    excerpt: article.excerpt ?? undefined,
    content: t.text,
    truncated: t.truncated,
    charsReturned: t.text.length,
  };
}

function isCloudflareChallenge(response: Response): boolean {
  return (
    response.status === 403 &&
    response.headers.get("cf-mitigated")?.toLowerCase() === "challenge"
  );
}

async function fetchOnce(url: string, userAgent: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": userAgent,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.9",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithLimits(url: string): Promise<{ body: string; contentType: string }> {
  let response = await fetchOnce(url, BROWSER_UA);
  if (isCloudflareChallenge(response)) {
    response = await fetchOnce(url, FALLBACK_UA);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    throw new Error(`Response too large: ${declared} bytes (max ${MAX_BODY_BYTES})`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new Error(`Response exceeded ${MAX_BODY_BYTES} bytes`);
  }

  return { body: new TextDecoder("utf-8").decode(buffer), contentType };
}

export const localProvider: ExtractProvider = {
  id: "local",
  async extract(opts: ExtractOptions): Promise<ExtractResult> {
    const fetched = await fetchWithLimits(opts.url);
    const ct = fetched.contentType.toLowerCase();

    if (ct.includes("application/pdf") || opts.url.toLowerCase().endsWith(".pdf")) {
      throw new Error("PDF extraction is not supported in this version");
    }

    if (
      ct.startsWith("text/plain") ||
      ct.includes("application/json") ||
      ct.includes("text/markdown")
    ) {
      const t = truncate(fetched.body, opts.maxChars);
      return {
        url: opts.url,
        provider: "local",
        content: t.text,
        truncated: t.truncated,
        charsReturned: t.text.length,
      };
    }

    if (!ct.includes("html") && ct.length > 0) {
      throw new Error(`Unsupported content type: ${ct}`);
    }

    return extractFromHtml(fetched.body, opts.url, opts.format, opts.maxChars);
  },
};
