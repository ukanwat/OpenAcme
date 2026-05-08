export type ExtractFormat = "markdown" | "text" | "html";

export interface ExtractOptions {
  url: string;
  format: ExtractFormat;
  maxChars: number;
}

export interface ExtractResult {
  url: string;
  provider: string;
  // Actual format of `content`. Caller-requested format is best-effort; some
  // providers (Firecrawl) don't have a native plain-text mode and serve
  // markdown for "text" requests.
  format?: ExtractFormat;
  title?: string;
  byline?: string;
  lang?: string;
  excerpt?: string;
  publishedDate?: string;
  content: string;
  truncated: boolean;
  charsReturned: number;
}

export interface ExtractProvider {
  readonly id: string;
  // apiKey is optional for providers that have an unauthenticated path (Jina).
  extract(opts: ExtractOptions, apiKey?: string): Promise<ExtractResult>;
}

export function truncate(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
