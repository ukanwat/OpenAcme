/**
 * Per-agent persistent memory store.
 *
 * Each agent has a `MEMORY.md` next to its `AGENT.md`:
 *   <agentsDir>/<agentId>/MEMORY.md
 *
 * Format mirrors Hermes (`tools/memory_tool.py`): char-bounded text,
 * `\n§\n` between entries, deduplicated on load, atomic-rename writes.
 *
 * Concurrency: per-agent in-process async mutex serializes
 * read-modify-write. Cross-process safety is NOT provided — atomic
 * rename keeps readers consistent, and we assume one process owns a
 * given dataDir at a time.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const MEMORY_FILE = "MEMORY.md";
const ENTRY_DELIMITER = "\n§\n";
const TMP_PREFIX = ".mem_";
const PREVIEW_LEN = 80;

/** Hermes default. Single source of truth — schema imports from here. */
export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;

// Same constraint agent-store uses; duplicated here so this module stays
// independent of `@openacme/config`.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface MemoryUsage {
  used: number;
  limit: number;
  entries: string[];
}

export type WriteResult =
  | {
      ok: true;
      usage: MemoryUsage;
      /** True iff `add` matched an existing entry exactly (silent success). */
      duplicate?: boolean;
    }
  | {
      ok: false;
      error: string;
      usage: MemoryUsage;
      matches?: string[];
    };

// ── Pure helpers ────────────────────────────────────────────────────

function preview(entry: string): string {
  if (entry.length <= PREVIEW_LEN) return entry;
  return entry.slice(0, PREVIEW_LEN) + "...";
}

function totalChars(entries: string[]): number {
  if (entries.length === 0) return 0;
  return (
    entries.reduce((n, e) => n + e.length, 0) +
    ENTRY_DELIMITER.length * (entries.length - 1)
  );
}

function serialize(entries: string[]): string {
  if (entries.length === 0) return "";
  return entries.join(ENTRY_DELIMITER) + "\n";
}

function findUniqueMatch(
  entries: string[],
  oldText: string
): { kind: "none" } | { kind: "one"; index: number } | { kind: "many"; matches: string[] } {
  if (!oldText) return { kind: "none" };
  const matchIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.includes(oldText)) matchIndices.push(i);
  }
  if (matchIndices.length === 0) return { kind: "none" };

  // Collapse byte-identical matches (load-time dedup makes this rare,
  // but Hermes keeps the defensive arm — port verbatim).
  const unique = new Map<string, number>();
  for (const i of matchIndices) {
    if (!unique.has(entries[i]!)) unique.set(entries[i]!, i);
  }
  if (unique.size === 1) {
    return { kind: "one", index: unique.values().next().value! };
  }
  return {
    kind: "many",
    matches: Array.from(unique.keys()).map(preview),
  };
}

// ── MemoryStore ─────────────────────────────────────────────────────

/**
 * Per-agent memory store. One instance per `agentsDir` — multiple
 * instances with different roots get independent mutex maps, which
 * matters for tests and multi-tenant deployments.
 */
export class MemoryStore {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(readonly agentsDir: string) {}

  // Public path helper — used by the CLI to show users where memory lives.
  filePath(agentId: string): string {
    if (!SAFE_ID.test(agentId)) {
      throw new Error(
        `Invalid agent id ${JSON.stringify(agentId)}: must match ${SAFE_ID}`
      );
    }
    return path.join(this.agentsDir, agentId, MEMORY_FILE);
  }

  /** Read entries from disk (sync, no mutex — safe for render paths). */
  read(agentId: string): string[] {
    return this.readEntries(this.filePath(agentId));
  }

  /** Usage struct without rendering. */
  usage(agentId: string, charLimit: number): MemoryUsage {
    const entries = this.read(agentId);
    return { used: totalChars(entries), limit: charLimit, entries };
  }

  /**
   * Render the system-prompt block (header + entries) for `getSystemPrompt`.
   * Empty MEMORY.md → empty string so the caller can skip the section
   * without conditionals.
   */
  renderForPrompt(agentId: string, charLimit: number): string {
    const entries = this.read(agentId);
    if (entries.length === 0) return "";
    const used = totalChars(entries);
    const pct = Math.round((used / charLimit) * 100);
    const header = `══════════════════════════════════════════════
MEMORY [${pct}% — ${used}/${charLimit} chars]
══════════════════════════════════════════════`;
    return `${header}\n${entries.join("\n§\n")}`;
  }

  /** Add an entry. Exact-duplicate add returns silent success. */
  async add(
    agentId: string,
    content: string,
    charLimit: number
  ): Promise<WriteResult> {
    const file = this.filePath(agentId);
    return this.withMutex(agentId, async () => {
      const entries = this.readEntries(file);
      const trimmed = content.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: "content is required and must be non-empty",
          usage: this.makeUsage(entries, charLimit),
        };
      }
      if (entries.includes(trimmed)) {
        return {
          ok: true,
          duplicate: true,
          usage: this.makeUsage(entries, charLimit),
        };
      }
      const next = [...entries, trimmed];
      const nextLen = totalChars(next);
      if (nextLen > charLimit) {
        const used = totalChars(entries);
        return {
          ok: false,
          error: `Memory at ${used}/${charLimit} chars. Adding this entry (${trimmed.length} chars) would exceed the limit. Replace or remove existing entries first.`,
          usage: { used, limit: charLimit, entries },
        };
      }
      await this.writeEntries(file, next);
      return { ok: true, usage: { used: nextLen, limit: charLimit, entries: next } };
    });
  }

  /**
   * Replace the unique entry containing `oldText` with `newContent`.
   * Multiple unique matches → error with previews so the agent can
   * pick a more specific substring.
   */
  async replace(
    agentId: string,
    oldText: string,
    newContent: string,
    charLimit: number
  ): Promise<WriteResult> {
    const file = this.filePath(agentId);
    return this.withMutex(agentId, async () => {
      const entries = this.readEntries(file);
      if (!oldText) {
        return {
          ok: false,
          error: "old_text is required and must be non-empty",
          usage: this.makeUsage(entries, charLimit),
        };
      }
      const trimmedNew = newContent.trim();
      if (!trimmedNew) {
        return {
          ok: false,
          error: "content is required and must be non-empty (use 'remove' to delete entries)",
          usage: this.makeUsage(entries, charLimit),
        };
      }
      const m = findUniqueMatch(entries, oldText);
      if (m.kind === "none") {
        return {
          ok: false,
          error: `No entry contains the substring ${JSON.stringify(oldText)}.`,
          usage: this.makeUsage(entries, charLimit),
        };
      }
      if (m.kind === "many") {
        return {
          ok: false,
          error: `Substring ${JSON.stringify(oldText)} matches multiple entries. Use a more specific substring.`,
          matches: m.matches,
          usage: this.makeUsage(entries, charLimit),
        };
      }
      const next = [...entries];
      next[m.index] = trimmedNew;
      // Re-dedup: if the new content already exists elsewhere, drop the
      // duplicate slot (keeping first-seen order).
      const dedup = Array.from(new Set(next));
      const nextLen = totalChars(dedup);
      if (nextLen > charLimit) {
        const used = totalChars(entries);
        return {
          ok: false,
          error: `Memory at ${used}/${charLimit} chars. Replacement would push it to ${nextLen}/${charLimit}. Shorten or remove other entries first.`,
          usage: { used, limit: charLimit, entries },
        };
      }
      await this.writeEntries(file, dedup);
      return { ok: true, usage: { used: nextLen, limit: charLimit, entries: dedup } };
    });
  }

  /** Remove the unique entry containing `oldText`. */
  async remove(
    agentId: string,
    oldText: string,
    charLimit: number
  ): Promise<WriteResult> {
    const file = this.filePath(agentId);
    return this.withMutex(agentId, async () => {
      const entries = this.readEntries(file);
      if (!oldText) {
        return {
          ok: false,
          error: "old_text is required and must be non-empty",
          usage: this.makeUsage(entries, charLimit),
        };
      }
      const m = findUniqueMatch(entries, oldText);
      if (m.kind === "none") {
        return {
          ok: false,
          error: `No entry contains the substring ${JSON.stringify(oldText)}.`,
          usage: this.makeUsage(entries, charLimit),
        };
      }
      if (m.kind === "many") {
        return {
          ok: false,
          error: `Substring ${JSON.stringify(oldText)} matches multiple entries. Use a more specific substring.`,
          matches: m.matches,
          usage: this.makeUsage(entries, charLimit),
        };
      }
      const next = entries.filter((_, i) => i !== m.index);
      await this.writeEntries(file, next);
      return { ok: true, usage: { used: totalChars(next), limit: charLimit, entries: next } };
    });
  }

  // ── Internals ────────────────────────────────────────────────────

  private makeUsage(entries: string[], charLimit: number): MemoryUsage {
    return { used: totalChars(entries), limit: charLimit, entries };
  }

  private readEntries(file: string): string[] {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const parts = trimmed
      .split(ENTRY_DELIMITER)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return Array.from(new Set(parts));
  }

  private async writeEntries(file: string, entries: string[]): Promise<void> {
    const dir = path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });

    const tmp = path.join(
      dir,
      `${TMP_PREFIX}${randomBytes(8).toString("hex")}.tmp`
    );
    let fh: fsp.FileHandle | null = null;
    try {
      fh = await fsp.open(tmp, "w");
      await fh.writeFile(serialize(entries), "utf-8");
      await fh.sync();
      await fh.close();
      fh = null;
      await fsp.rename(tmp, file);
    } catch (e) {
      if (fh) {
        try {
          await fh.close();
        } catch {
          // ignore
        }
      }
      try {
        await fsp.unlink(tmp);
      } catch {
        // ignore — best-effort cleanup
      }
      throw e;
    }
  }

  /**
   * Per-agent mutex. Map stores only the settle-completion of each
   * outstanding write, never its rejection — so a thrown error inside
   * one writer can't poison the chain for the next.
   */
  private async withMutex<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.inFlight.get(agentId) ?? Promise.resolve();
    const result = prev.then(work, work);
    this.inFlight.set(
      agentId,
      result.then(
        () => undefined,
        () => undefined
      )
    );
    return result;
  }
}
