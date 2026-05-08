import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { highlight } from "cli-highlight";

const marked = new Marked();
marked.use(
  markedTerminal({
    code: (code: string, lang?: string) =>
      highlight(code, {
        language: lang && lang.length > 0 ? lang : "plaintext",
        ignoreIllegals: true,
      }),
    width: Math.min(process.stdout.columns ?? 100, 100),
    reflowText: true,
  }) as unknown as Parameters<typeof marked.use>[0]
);

export function renderMarkdown(source: string): string {
  const out = marked.parse(source, { async: false }) as string;
  return out.replace(/\n+$/, "");
}
