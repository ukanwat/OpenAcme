// Pure helpers for per-tool rendering in the CLI ToolBlock.
// Mirrors the web's apps/web/app/components/ToolBlock.tsx helpers — kept
// duplicated rather than extracted because OpenAcme has no shared UI-helper
// package and the parsing logic is stable. Keep in sync.

export const KNOWN_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit",
  "apply_patch",
  "list_files",
  "search_files",
  "shell",
  "execute_code",
  "web_search",
  "session_search",
  "web_extract",
  "skill_view",
  "memory",
  "task_create",
  "task_view",
  "task_update",
  "task_list",
  "task_comment",
  "task_comments",
  "process",
  "ping_user",
  "sleep",
]);

export type DiffLineType = " " | "-" | "+";
export interface DiffLine {
  type: DiffLineType;
  text: string;
}
export interface DiffHunk {
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  kind: "add" | "update" | "delete" | "move" | "edit";
  newPath?: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
export function trim(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…";
}
export function firstNonEmptyLine(s: string): string {
  for (const line of s.split("\n")) {
    if (line.trim()) return line;
  }
  return s;
}
export function shortPath(p: string): string {
  if (p.length < 60) return p;
  const segs = p.split("/");
  if (segs.length <= 4) return p;
  return ".../" + segs.slice(-3).join("/");
}
export function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
export function parseJsonish(v: unknown): Record<string, unknown> | null {
  if (isObj(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return isObj(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}
export function formatOutput(output: unknown, errorText?: string): string {
  if (errorText) return errorText;
  if (output === undefined) return "";
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return output;
    }
  }
  return safeStringify(output);
}

export function pickTaskId(out: Record<string, unknown> | null): string | undefined {
  if (!out) return undefined;
  const task = out["task"];
  if (isObj(task) && typeof task["id"] === "string") return task["id"];
  if (typeof out["task_id"] === "string") return out["task_id"] as string;
  if (typeof out["id"] === "string") return out["id"] as string;
  return undefined;
}

export function countResults(out: Record<string, unknown> | null): number | null {
  if (!out) return null;
  const candidates = [out["results"], out["matches"], out["hits"], out["items"], out["tasks"]];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.length;
  }
  return null;
}

export interface SearchResult {
  title?: string;
  url?: string;
  snippet?: string;
}
export function pickResults(
  out: Record<string, unknown> | null
): SearchResult[] | null {
  if (!out) return null;
  const arr =
    (Array.isArray(out["results"]) && (out["results"] as unknown[])) ||
    (Array.isArray(out["matches"]) && (out["matches"] as unknown[])) ||
    (Array.isArray(out["hits"]) && (out["hits"] as unknown[])) ||
    (Array.isArray(out["items"]) && (out["items"] as unknown[])) ||
    null;
  if (!arr) return null;
  return arr.filter(isObj).map((r) => ({
    title: str(r["title"]) ?? str(r["name"]),
    url: str(r["url"]) ?? str(r["link"]),
    snippet: str(r["snippet"]) ?? str(r["text"]) ?? str(r["content"]),
  }));
}

export function lineDiffSingleHunk(oldText: string, newText: string): DiffHunk {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  let p = 0;
  while (
    p < oldLines.length &&
    p < newLines.length &&
    oldLines[p] === newLines[p]
  )
    p++;
  let s = 0;
  while (
    s < oldLines.length - p &&
    s < newLines.length - p &&
    oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]
  )
    s++;
  const ctx = 2;
  const prefixCtx = oldLines.slice(Math.max(0, p - ctx), p);
  const suffixCtx = oldLines.slice(
    oldLines.length - s,
    oldLines.length - s + ctx
  );
  const removed = oldLines.slice(p, oldLines.length - s);
  const added = newLines.slice(p, newLines.length - s);
  const lines: DiffLine[] = [
    ...prefixCtx.map((t) => ({ type: " " as const, text: t })),
    ...removed.map((t) => ({ type: "-" as const, text: t })),
    ...added.map((t) => ({ type: "+" as const, text: t })),
    ...suffixCtx.map((t) => ({ type: " " as const, text: t })),
  ];
  return { lines };
}

export function editToFile(path: string, oldText: string, newText: string): DiffFile {
  const hunk = lineDiffSingleHunk(oldText, newText);
  let added = 0,
    removed = 0;
  for (const l of hunk.lines) {
    if (l.type === "+") added++;
    else if (l.type === "-") removed++;
  }
  const kind: DiffFile["kind"] = oldText === "" ? "add" : "edit";
  return { path, kind, added, removed, hunks: [hunk] };
}

// V4A patch envelope used by apply_patch. See packages/tools/src/patch/parser.ts
// for the writer side. This is a presentation-only parser; tolerant of
// minor variants.
export function parseV4APatch(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split("\n");
  let cur: DiffFile | null = null;
  let curHunk: DiffHunk | null = null;

  const flushHunk = () => {
    if (cur && curHunk && curHunk.lines.length > 0) {
      cur.hunks.push(curHunk);
    }
    curHunk = null;
  };
  const flushFile = () => {
    flushHunk();
    if (cur) files.push(cur);
    cur = null;
  };

  for (const raw of lines) {
    const line = raw;
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) {
      flushFile();
      cur = { path: m[1] as string, kind: "add", added: 0, removed: 0, hunks: [] };
      curHunk = { lines: [] };
      continue;
    }
    if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) {
      flushFile();
      cur = {
        path: m[1] as string,
        kind: "update",
        added: 0,
        removed: 0,
        hunks: [],
      };
      curHunk = null;
      continue;
    }
    if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      flushFile();
      cur = {
        path: m[1] as string,
        kind: "delete",
        added: 0,
        removed: 0,
        hunks: [],
      };
      curHunk = { lines: [] };
      continue;
    }
    if ((m = /^\*\*\* Move File: (.+) -> (.+)$/.exec(line))) {
      flushFile();
      cur = {
        path: m[1] as string,
        newPath: m[2] as string,
        kind: "move",
        added: 0,
        removed: 0,
        hunks: [],
      };
      curHunk = null;
      continue;
    }
    if (line.startsWith("*** End of File")) {
      flushFile();
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@")) {
      flushHunk();
      curHunk = { lines: [] };
      continue;
    }
    if (cur.kind === "delete") {
      curHunk ??= { lines: [] };
      curHunk.lines.push({ type: "-", text: line });
      cur.removed++;
      continue;
    }
    if (cur.kind === "add") {
      curHunk ??= { lines: [] };
      const t = line.startsWith("+") ? line.slice(1) : line;
      curHunk.lines.push({ type: "+", text: t });
      cur.added++;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      curHunk ??= { lines: [] };
      curHunk.lines.push({ type: " ", text: line.startsWith(" ") ? line.slice(1) : line });
    } else if (line.startsWith("-")) {
      curHunk ??= { lines: [] };
      curHunk.lines.push({ type: "-", text: line.slice(1) });
      cur.removed++;
    } else if (line.startsWith("+")) {
      curHunk ??= { lines: [] };
      curHunk.lines.push({ type: "+", text: line.slice(1) });
      cur.added++;
    }
  }
  flushFile();
  return files;
}
