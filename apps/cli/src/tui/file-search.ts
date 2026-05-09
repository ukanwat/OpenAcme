import * as path from "node:path";
import { globby } from "globby";
import { Fzf, extendedMatch, type FzfResultItem } from "fzf";

// Walk every file under `root` for the @-picker. Build outputs,
// gitignored fixtures, dotfiles, screenshots all surface. Two dirs are
// skipped because they're universal noise that drowns real results out
// of the limit-N window: `node_modules` (pnpm aliases every workspace
// file under .pnpm so each match dupes 5+ times) and `.git` (binary
// object store, no attachable content). This is not a gitignore filter
// — works the same in or out of a git repo.
export async function listProjectFiles(root: string): Promise<string[]> {
  const matches = await globby(["**"], {
    cwd: root,
    dot: true,
    onlyFiles: true,
    suppressErrors: true,
    ignore: ["**/node_modules/**", "**/.git/**"],
  });
  return matches.map((rel) => path.resolve(root, rel));
}

/**
 * Build an Fzf matcher over the file list. Returned function takes a
 * query and yields the top-`limit` matches as absolute paths. Uses
 * `extendedMatch` so a space in the query splits tokens into an AND
 * (each token fuzzy-matched independently) — without it, "tui App"
 * requires a literal space in the path and matches nothing. With it,
 * "tui App" matches `apps/cli/src/tui/App.tsx`.
 */
export function makeRanker(
  files: string[],
  root: string,
  limit = 10
): (query: string) => string[] {
  const rels = files.map((f) => path.relative(root, f));
  const fzf = new Fzf(rels, { limit, match: extendedMatch });
  return (query: string) => {
    if (!query) return files.slice(0, limit);
    const hits = fzf.find(query) as FzfResultItem<string>[];
    return hits.map((h) => path.resolve(root, h.item));
  };
}

/**
 * If the buffer ends with an `@<query>` token (no whitespace between the
 * `@` and the cursor), return `query`. Otherwise null. The `@` must be
 * at start-of-string or preceded by whitespace so we don't trigger on
 * emails like `user@example.com`.
 */
export function detectAtQuery(buffer: string): string | null {
  const m = buffer.match(/(^|\s)@([^\s]*)$/);
  return m ? (m[2] ?? "") : null;
}

/**
 * Replace the trailing `@<query>` in `buffer` with `@<replacement>` and
 * a trailing space so the user can keep typing. `replacement` should be
 * a path with no spaces — the caller is responsible for choosing one
 * that doesn't need escaping.
 */
export function replaceAtToken(buffer: string, replacement: string): string {
  return buffer.replace(/(^|\s)@([^\s]*)$/, `$1@${replacement} `);
}

/**
 * Strip the trailing `@<query>` from `buffer`, preserving the leading
 * whitespace boundary. Used when we accept an attachable file via the
 * picker — the attachment goes into the pending list, the @-token
 * disappears from the input rather than turning into literal text.
 */
export function stripAtToken(buffer: string): string {
  return buffer.replace(/(^|\s)@([^\s]*)$/, "$1");
}
