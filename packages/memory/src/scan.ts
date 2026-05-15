/**
 * Memory-directory scanning + manifest formatting. Shared by the recall
 * selector (Phase 2) and the extraction subagent (Phase 3) — pulled out
 * so neither has to duplicate the readdir/frontmatter walk.
 *
 * Port of Claude Code `memdir/memoryScan.ts`. Two intentional simplifications:
 * - `MemoryType` taxonomy dropped (see plan §B). The manifest line just
 *   omits the `[type] ` prefix.
 * - We parse `description` from frontmatter via a tight regex rather
 *   than pulling in gray-matter — keeps `@openacme/memory` dep-free
 *   (other workspace packages with gray-matter aren't reachable from
 *   here, and the convention is `description: <one line>` so a multi-
 *   line value isn't part of the contract anyway).
 *
 * Caps mirror Claude Code: `MAX_MEMORY_FILES = 200` on the result set
 * (newest-first) so the manifest can't grow unbounded; per-file we read
 * only the head bytes needed for frontmatter rather than the whole body.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createReadStream } from "node:fs";

const MAX_MEMORY_FILES = 200;
const FRONTMATTER_MAX_LINES = 30;
const INDEX_FILE = "MEMORY.md";

export interface MemoryHeader {
  /** Path relative to memoryDir (may include subdirs). */
  filename: string;
  /** Absolute filesystem path. */
  filePath: string;
  mtimeMs: number;
  /** Frontmatter `description` if present, else null. */
  description: string | null;
}

/**
 * Read the first `maxLines` of a file. Frontmatter is always at the top;
 * cap at 30 lines (matches Claude Code) so we don't pull entire entry
 * bodies into memory just to peek at YAML.
 */
async function readHead(filePath: string, maxLines: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let lines = 0;
    let buf = "";
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    let settled = false;
    const finish = (s: string) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(s);
    };
    stream.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0 && lines < maxLines) {
        chunks.push(buf.slice(0, idx + 1));
        buf = buf.slice(idx + 1);
        lines++;
      }
      if (lines >= maxLines) finish(chunks.join(""));
    });
    stream.on("end", () => finish(chunks.join("") + buf));
    stream.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

/** Pull the `description` field out of YAML frontmatter, if present. */
export function parseFrontmatterDescription(head: string): string | null {
  if (!head.startsWith("---")) return null;
  const close = head.indexOf("\n---", 3);
  if (close < 0) return null;
  const block = head.slice(3, close);
  // Tolerate optional surrounding quotes.
  const m = /^description:\s*(?:"([^"]*)"|'([^']*)'|(.*))\s*$/m.exec(block);
  if (!m) return null;
  const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
  return v.length > 0 ? v : null;
}

/**
 * Walk a memory directory recursively, return headers sorted newest-first
 * and capped at MAX_MEMORY_FILES. Excludes MEMORY.md (already loaded into
 * the system prompt) and hidden dotfiles.
 *
 * Per-file failures (read errors, missing entries) are dropped silently —
 * the scan must be best-effort, since both callers (selector + extractor)
 * are advisory paths that should never fail the parent turn.
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal?: AbortSignal
): Promise<MemoryHeader[]> {
  let entries: string[];
  try {
    entries = await readdir(memoryDir, { recursive: true });
  } catch {
    return [];
  }
  if (signal?.aborted) return [];

  const candidates = entries.filter(
    (f) =>
      f.endsWith(".md") &&
      basename(f) !== INDEX_FILE &&
      !f.split("/").some((seg) => seg.startsWith("."))
  );

  const results = await Promise.allSettled(
    candidates.map(async (rel): Promise<MemoryHeader> => {
      const filePath = join(memoryDir, rel);
      const [head, st] = await Promise.all([
        readHead(filePath, FRONTMATTER_MAX_LINES),
        stat(filePath),
      ]);
      return {
        filename: rel,
        filePath,
        mtimeMs: st.mtimeMs,
        description: parseFrontmatterDescription(head),
      };
    })
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<MemoryHeader> => r.status === "fulfilled"
    )
    .map((r) => r.value)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES);
}

/**
 * Format scanned headers as a text manifest. One line per file:
 * `- <filename> (<iso-ts>): <description?>`. Used by both the selector's
 * Sonnet prompt and the extractor's pre-injected listing.
 */
export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers
    .map((m) => {
      const ts = new Date(m.mtimeMs).toISOString();
      return m.description
        ? `- ${m.filename} (${ts}): ${m.description}`
        : `- ${m.filename} (${ts})`;
    })
    .join("\n");
}

export const __test = { readHead, MAX_MEMORY_FILES, FRONTMATTER_MAX_LINES };
