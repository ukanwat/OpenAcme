/**
 * Memory-directory scan + manifest formatting. Shared by the recall
 * selector and the extractor. CC `memdir/memoryScan.ts` lift; we drop
 * the type taxonomy and parse `description` via a tight regex (keeps
 * @openacme/memory dependency-free).
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createReadStream } from "node:fs";

const MAX_MEMORY_FILES = 200;
const FRONTMATTER_MAX_LINES = 30;
const INDEX_FILE = "MEMORY.md";

export interface MemoryHeader {
  /** Path relative to memoryDir. */
  filename: string;
  /** Absolute filesystem path. */
  filePath: string;
  mtimeMs: number;
  description: string | null;
}

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

/** Recursive scan, sorted newest-first, capped at MAX_MEMORY_FILES.
 *  Best-effort: per-file read failures dropped silently. */
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

/** Format: `- <filename> (<iso-ts>): <description?>` per line. */
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
