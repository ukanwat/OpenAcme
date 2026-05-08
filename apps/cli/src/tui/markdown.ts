import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { highlight } from "cli-highlight";

const marked = new Marked();

// `marked-terminal@7` (with `marked@15`) has a bug where its `text` renderer
// returns the raw `token.text` instead of recursing into `token.tokens` via
// `parseInline`. That breaks inline emphasis inside list items: `**bold**`
// and `_italic_` arrive at the screen with literal markers, no ANSI styling.
// (Top-level paragraphs work because the paragraph renderer DOES call
// `parseInline`.) See node_modules/marked-terminal/index.js:84-89.
//
// Fix: wrap the extension's text renderer to call parseInline whenever the
// token has child inline tokens. Falls back to the original on plain strings.
interface RendererBag { renderer: Record<string, (...args: unknown[]) => string> }
const ext = markedTerminal({
  code: (code: string, lang?: string) =>
    highlight(code, {
      language: lang && lang.length > 0 ? lang : "plaintext",
      ignoreIllegals: true,
    }),
  width: Math.min(process.stdout.columns ?? 100, 100),
  reflowText: true,
}) as unknown as RendererBag;

const origText = ext.renderer["text"]!;
ext.renderer["text"] = function (this: unknown, ...args: unknown[]) {
  const token = args[0];
  if (
    token &&
    typeof token === "object" &&
    Array.isArray((token as { tokens?: unknown[] }).tokens) &&
    (token as { tokens: unknown[] }).tokens.length > 0
  ) {
    const ctx = this as { parser: { parseInline: (t: unknown[]) => string } };
    return ctx.parser.parseInline((token as { tokens: unknown[] }).tokens);
  }
  return origText.apply(this, args);
};

marked.use(ext as unknown as Parameters<typeof marked.use>[0]);

export function renderMarkdown(source: string): string {
  const out = marked.parse(source, { async: false }) as string;
  return out.replace(/\n+$/, "");
}
