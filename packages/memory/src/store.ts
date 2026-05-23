/**
 * Per-agent persistent memory store — directory-backed, six-op shape
 * matching Anthropic's `memory_20250818` tool spec.
 *
 * Layout per agent:
 *
 *   <agentsDir>/<agentId>/memory/
 *     MEMORY.md            ← always-injected index of one-line pointers
 *     <topic>.md           ← agent-created entry files (read on demand)
 *     <subdir>/<topic>.md  ← agent-organized; we don't enforce layout
 *
 * Tool calls reference paths as **bare relative names** keyed off the
 * agent's memory dir: `MEMORY.md`, `notes.md`, `peers/coder.md`. These
 * match the link targets shown in `MEMORY.md` verbatim so the agent never
 * has to translate between what it reads in the index and what it passes
 * to the tool. The store rejects leading slashes (which read as absolute
 * paths and trip the agent into using shell tools) and any `..` traversal
 * that escapes the per-agent root.
 *
 * Concurrency: per-agent in-process async mutex serializes
 * read-modify-write. Cross-process safety is NOT provided — atomic rename
 * keeps readers consistent, and we assume one process owns a given dataDir
 * at a time.
 *
 * Caps:
 *   - Per-file line cap = 999,999 (Anthropic spec verbatim).
 *   - MEMORY.md index has a write-time char cap (`memoryCharLimit`,
 *     default 4000). Writes that would push it over return OpenAcme's
 *     existing guidance string ("Memory at X/Y chars. ...Replace or
 *     remove existing entries first.") so the agent has consolidation
 *     pressure rather than infinite append.
 *   - Per-entry files have NO char cap (they're not auto-injected;
 *     only the per-file line cap applies).
 *
 * Return strings: each op returns the EXACT string Anthropic specifies
 * (line-number format, directory listing format, error wording). Models
 * are trained against those literals; matching them is what makes
 * `memory_20250818`-trained behavior carry over without prompt
 * engineering.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { memoryFreshnessNote } from "./freshness.js";

// ── Constants ──────────────────────────────────────────────────────────

const MEMORY_DIR = "memory";
const INDEX_FILE = "MEMORY.md";
const TMP_PREFIX = ".mem_";

/** Per-file line cap (Anthropic spec). */
const MAX_FILE_LINES = 999_999;

/** Single source of truth for the per-agent MEMORY.md index char cap.
 *  Sized for ~40-80 tight one-liner entries; raise via per-agent
 *  frontmatter when the agent's surface area genuinely needs more. */
export const DEFAULT_MEMORY_CHAR_LIMIT = 4000;

/** Same constraint agent-store uses; duplicated here so this module stays
 * independent of `@openacme/config`. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// ── Types ──────────────────────────────────────────────────────────────

export interface IndexSnapshot {
  /** Raw `MEMORY.md` content, untruncated. Empty string if the file is
   *  missing or empty. */
  content: string;
  /** Byte length of `content`. */
  used: number;
  /** Configured char cap (write-time). */
  limit: number;
  /** Number of `.md` files under `<agentDir>/memory/` excluding
   *  `MEMORY.md` itself. Used by prompt builder to decide when to append
   *  Anthropic's "keep your memory folder organized" instruction. */
  entryCount: number;
}

// ── Pure helpers ───────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/** Format a 1-indexed line number in 6-char right-aligned form (Anthropic). */
function fmtLineNo(n: number): string {
  return String(n).padStart(6, " ");
}

/** Render file contents with Anthropic's line-number format. */
function withLineNumbers(content: string): string {
  const lines = content.length === 0 ? [""] : content.split("\n");
  return lines.map((line, i) => `${fmtLineNo(i + 1)}\t${line}`).join("\n");
}

/** Find ALL line numbers (1-indexed) where `needle` appears in `haystack`. */
function findOccurrenceLines(haystack: string, needle: string): number[] {
  const lines: number[] = [];
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    // 1-indexed line number of the occurrence start
    const lineNo = haystack.slice(0, idx).split("\n").length;
    lines.push(lineNo);
    from = idx + needle.length;
  }
  return lines;
}

/** Count occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

// ── MemoryStore ────────────────────────────────────────────────────────

/**
 * Per-agent memory store. One instance per `agentsDir` — multiple
 * instances with different roots get independent mutex maps, which
 * matters for tests and multi-tenant deployments.
 */
export class MemoryStore {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(readonly agentsDir: string) {}

  // ── Path helpers ─────────────────────────────────────────────────────

  /** Absolute path to an agent's memory directory. Does not create it. */
  dirPath(agentId: string): string {
    if (!SAFE_ID.test(agentId)) {
      throw new Error(
        `Invalid agent id ${JSON.stringify(agentId)}: must match ${SAFE_ID}`
      );
    }
    return path.join(this.agentsDir, agentId, MEMORY_DIR);
  }

  /** Absolute path to the index file for an agent. Does not create it. */
  indexPath(agentId: string): string {
    return path.join(this.dirPath(agentId), INDEX_FILE);
  }

  /**
   * Translate a tool-supplied path to an absolute filesystem path under
   * `<agentsDir>/<agentId>/memory/`. Paths are **bare relative names**
   * keyed off the agent's memory dir: `MEMORY.md`, `notes.md`,
   * `peers/coder.md`. They match the link targets shown in `MEMORY.md`
   * verbatim, so the agent never has to translate between what it reads
   * in the index and what it passes to the tool.
   *
   * Rejects:
   *   - Non-string inputs
   *   - Leading slash (looks like an absolute filesystem path; the model
   *     reaches for shell tools and gets confused)
   *   - URL-encoded traversal sequences (`%2e%2e%2f`, etc.)
   *   - Resolved paths that escape the per-agent root (defense in depth
   *     against `..`)
   *
   * The empty-string case is special: `""` means "the memory dir root",
   * used by `view` to list entries. All other ops require a non-empty path.
   */
  private translatePath(
    agentId: string,
    virtualPath: string
  ): { ok: true; abs: string } | { ok: false; error: string } {
    if (typeof virtualPath !== "string") {
      return {
        ok: false,
        error: `Invalid path. Pass a bare relative name like 'MEMORY.md' or 'peers/coder.md'.`,
      };
    }
    if (virtualPath.startsWith("/")) {
      return {
        ok: false,
        error: `Memory paths are relative to the memory dir — drop the leading '/'. Pass '${virtualPath.replace(/^\/+(memories\/)?/, "")}' instead.`,
      };
    }
    // Reject URL-encoded traversal before any normalization
    const lowered = virtualPath.toLowerCase();
    if (lowered.includes("%2e") || lowered.includes("%2f") || lowered.includes("%5c")) {
      return {
        ok: false,
        error: `Invalid path '${virtualPath}'.`,
      };
    }
    const root = this.dirPath(agentId);
    const abs = path.resolve(root, virtualPath);
    // Defense in depth: ensure the resolved path is still under root.
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        ok: false,
        error: `Path '${virtualPath}' escapes the memory dir.`,
      };
    }
    return { ok: true, abs };
  }

  /** True if the path points at the index file specifically. */
  private isIndexPath(virtualPath: string): boolean {
    return virtualPath === INDEX_FILE || virtualPath === `${INDEX_FILE}/`;
  }

  // ── Index accessor (for prompt builder) ──────────────────────────────

  /**
   * Snapshot of the agent's index for system-prompt injection.
   * Synchronous; safe for render paths. Counts entry files for the
   * prompt builder's "cluttered memory" trigger.
   */
  readIndex(agentId: string, charLimit: number): IndexSnapshot {
    const indexFile = this.indexPath(agentId);
    let content = "";
    try {
      content = fs.readFileSync(indexFile, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const trimmed = content.trim();
    const used = trimmed.length;

    // Walk the dir for entry files (non-recursive — rare but possible
    // sub-dirs are counted under the prompt-builder's "cluttered" cap
    // via reading the same scan elsewhere; for the simple count signal
    // a flat enumeration is enough).
    let entryCount = 0;
    const dir = this.dirPath(agentId);
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILE) {
          entryCount++;
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    return { content: trimmed, used, limit: charLimit, entryCount };
  }

  // ── view ─────────────────────────────────────────────────────────────

  /**
   * `view` — show directory contents (2 levels deep) or file contents
   * with optional line range. For entry files (anything other than
   * `MEMORY.md`) older than 1 day, prepends `memoryFreshnessNote`.
   *
   * Synchronous; no mutex needed (read-only).
   */
  view(
    agentId: string,
    virtualPath: string,
    viewRange?: readonly [number, number]
  ): string {
    const t = this.translatePath(agentId, virtualPath);
    if (!t.ok) return t.error;
    const abs = t.abs;

    // Special case: viewing the root (empty string or `.`) of an agent
    // that hasn't touched memory yet. Return the empty-listing form
    // rather than "does not exist" so the dir always reads as existing.
    const isRoot = virtualPath === "" || virtualPath === "." || virtualPath === "./";

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        if (isRoot) return this.viewDirectory(agentId, virtualPath, abs);
        return `The path ${virtualPath} does not exist. Please provide a valid path.`;
      }
      throw e;
    }

    if (stat.isDirectory()) {
      return this.viewDirectory(agentId, virtualPath, abs);
    }

    // File path. Read content; honor optional view_range.
    let raw: string;
    try {
      raw = fs.readFileSync(abs, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return `The path ${virtualPath} does not exist. Please provide a valid path.`;
      }
      throw e;
    }

    const lines = raw.split("\n");
    if (lines.length > MAX_FILE_LINES) {
      return `File ${virtualPath} exceeds maximum line limit of 999,999 lines.`;
    }

    let displayLines = lines;
    let startOffset = 0;
    if (viewRange) {
      const [from, to] = viewRange;
      const start = Math.max(1, from) - 1;
      const end = to <= 0 ? lines.length : Math.min(lines.length, to);
      displayLines = lines.slice(start, end);
      startOffset = start;
    }

    const numbered = displayLines
      .map((line, i) => `${fmtLineNo(i + 1 + startOffset)}\t${line}`)
      .join("\n");

    const header = `Here's the content of ${virtualPath} with line numbers:`;
    let out = `${header}\n${numbered}`;

    // Freshness wrap for entry files (not the index).
    if (!this.isIndexPath(virtualPath)) {
      const note = memoryFreshnessNote(stat.mtimeMs);
      if (note.length > 0) out = note + out;
    }
    return out;
  }

  /**
   * Directory listing in Anthropic's format, adapted for OpenAcme:
   * the `node_modules` exclusion clause from the upstream spec is
   * dropped because OpenAcme's memory dir can never contain one (no
   * shell access, no package manager runs against it). We still
   * exclude hidden dotfiles so internal artifacts (future
   * coordination locks, sidecar state) stay out of the agent's view.
   */
  private viewDirectory(
    agentId: string,
    virtualPath: string,
    absRoot: string
  ): string {
    // Strip trailing slash for display + child-key composition. Empty
    // string (the dir root) renders as "(memory)" so the listing header
    // doesn't read awkwardly.
    const trimmed = virtualPath.replace(/\/$/, "");
    const displayRoot = trimmed === "" ? "(memory)" : trimmed;

    const lines: string[] = [
      `Here're the files and directories up to 2 levels deep in ${displayRoot}, excluding hidden items:`,
    ];

    // Root entry — total size of contents at depth ≤ 2.
    let rootBytes = 0;

    type Entry = { virtual: string; bytes: number };
    const out: Entry[] = [];

    const collect = (currentAbs: string, currentVirtual: string, depth: number) => {
      if (depth > 2) return;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(currentAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        if (d.name.startsWith(".")) continue;
        const childAbs = path.join(currentAbs, d.name);
        const childVirtual = currentVirtual === "" ? d.name : `${currentVirtual}/${d.name}`;
        if (d.isDirectory()) {
          out.push({ virtual: childVirtual, bytes: 0 });
          collect(childAbs, childVirtual, depth + 1);
        } else if (d.isFile()) {
          let size = 0;
          try {
            size = fs.statSync(childAbs).size;
          } catch {
            // ignore — listing should not fail because one file vanished
          }
          out.push({ virtual: childVirtual, bytes: size });
          rootBytes += size;
        }
      }
    };

    // Ensure the dir exists; if not, fabricate an empty listing rather
    // than erroring — empty memory dir is normal for fresh agents.
    if (fs.existsSync(absRoot)) {
      collect(absRoot, trimmed, 1);
    }

    lines.push(`${formatBytes(rootBytes)}\t${displayRoot}`);
    for (const e of out) {
      lines.push(`${formatBytes(e.bytes)}\t${e.virtual}`);
    }
    return lines.join("\n");
  }

  // ── create ───────────────────────────────────────────────────────────

  /**
   * `create` — create a new file. Errors if a file already exists at
   * the target path. For writes targeting `MEMORY.md`, enforces the
   * write-time char cap with OpenAcme's guidance string. For all
   * files, enforces the 999,999-line cap.
   */
  async create(
    agentId: string,
    virtualPath: string,
    fileText: string,
    indexCharLimit?: number
  ): Promise<string> {
    const t = this.translatePath(agentId, virtualPath);
    if (!t.ok) return t.error;
    const abs = t.abs;

    return this.withMutex(agentId, async () => {
      // Existence check
      try {
        await fsp.stat(abs);
        return `Error: File ${virtualPath} already exists`;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }

      const lineCount = fileText.split("\n").length;
      if (lineCount > MAX_FILE_LINES) {
        return `File ${virtualPath} exceeds maximum line limit of 999,999 lines.`;
      }

      // Write-time cap on MEMORY.md
      if (this.isIndexPath(virtualPath) && typeof indexCharLimit === "number") {
        if (fileText.trim().length > indexCharLimit) {
          return (
            `Memory at 0/${indexCharLimit} chars. Adding this entry ` +
            `(${fileText.trim().length} chars) would exceed the limit. ` +
            `Replace or remove existing entries first.`
          );
        }
      }

      await this.writeFileAtomic(abs, fileText);
      return `File created successfully at: ${virtualPath}`;
    });
  }

  // ── str_replace ──────────────────────────────────────────────────────

  /**
   * `str_replace` — replace `oldStr` with `newStr` in a file. Errors
   * on missing file, missing match, or multiple matches (Anthropic's
   * exact wording).
   */
  async strReplace(
    agentId: string,
    virtualPath: string,
    oldStr: string,
    newStr: string,
    indexCharLimit?: number
  ): Promise<string> {
    const t = this.translatePath(agentId, virtualPath);
    if (!t.ok) return `Error: ${t.error}`;
    const abs = t.abs;

    return this.withMutex(agentId, async () => {
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return `Error: The path ${virtualPath} does not exist. Please provide a valid path.`;
        }
        throw e;
      }
      // Directory passed → "file does not exist" error per Anthropic spec
      if (stat.isDirectory()) {
        return `Error: The path ${virtualPath} does not exist. Please provide a valid path.`;
      }

      const content = await fsp.readFile(abs, "utf-8");
      const occurrences = countOccurrences(content, oldStr);
      if (occurrences === 0) {
        return `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${virtualPath}.`;
      }
      if (occurrences > 1) {
        const lineNos = findOccurrenceLines(content, oldStr);
        return `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lineNos.join(", ")}. Please ensure it is unique`;
      }

      const next = content.replace(oldStr, newStr);

      // Line-cap check on the result
      if (next.split("\n").length > MAX_FILE_LINES) {
        return `File ${virtualPath} exceeds maximum line limit of 999,999 lines.`;
      }

      // Write-time cap on MEMORY.md
      if (this.isIndexPath(virtualPath) && typeof indexCharLimit === "number") {
        const newLen = next.trim().length;
        const oldLen = content.trim().length;
        if (newLen > indexCharLimit) {
          return (
            `Memory at ${oldLen}/${indexCharLimit} chars. Replacement would push it to ` +
            `${newLen}/${indexCharLimit}. Shorten or remove other entries first.`
          );
        }
      }

      await this.writeFileAtomic(abs, next);

      // Return success + a snippet-with-line-numbers per Anthropic spec
      const snippetLineNo = content.slice(0, content.indexOf(oldStr)).split("\n").length;
      const snippetLines = next.split("\n");
      const start = Math.max(0, snippetLineNo - 3);
      const end = Math.min(snippetLines.length, snippetLineNo + 5);
      const snippet = snippetLines
        .slice(start, end)
        .map((line, i) => `${fmtLineNo(i + 1 + start)}\t${line}`)
        .join("\n");
      return `The memory file has been edited.\n${snippet}`;
    });
  }

  // ── insert ───────────────────────────────────────────────────────────

  /**
   * `insert` — insert text at a specific line in a file. `insertLine` is
   * 0-indexed in Anthropic's spec (0 = before first line, N = after last).
   */
  async insert(
    agentId: string,
    virtualPath: string,
    insertLine: number,
    insertText: string,
    indexCharLimit?: number
  ): Promise<string> {
    const t = this.translatePath(agentId, virtualPath);
    if (!t.ok) return `Error: ${t.error}`;
    const abs = t.abs;

    return this.withMutex(agentId, async () => {
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return `Error: The path ${virtualPath} does not exist`;
        }
        throw e;
      }
      if (stat.isDirectory()) {
        return `Error: The path ${virtualPath} does not exist`;
      }

      const content = await fsp.readFile(abs, "utf-8");
      const lines = content.split("\n");
      const nLines = lines.length;
      if (insertLine < 0 || insertLine > nLines) {
        return `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${nLines}]`;
      }

      // Splice in insertText (treated as a single block — caller is
      // responsible for trailing newlines if they want a clean break).
      const next = [
        ...lines.slice(0, insertLine),
        insertText,
        ...lines.slice(insertLine),
      ].join("\n");

      if (next.split("\n").length > MAX_FILE_LINES) {
        return `File ${virtualPath} exceeds maximum line limit of 999,999 lines.`;
      }

      if (this.isIndexPath(virtualPath) && typeof indexCharLimit === "number") {
        const newLen = next.trim().length;
        const oldLen = content.trim().length;
        if (newLen > indexCharLimit) {
          return (
            `Memory at ${oldLen}/${indexCharLimit} chars. Insertion would push it to ` +
            `${newLen}/${indexCharLimit}. Shorten or remove other entries first.`
          );
        }
      }

      await this.writeFileAtomic(abs, next);
      return `The file ${virtualPath} has been edited.`;
    });
  }

  // ── delete ───────────────────────────────────────────────────────────

  /**
   * `delete` — recursively delete a file or directory. Anthropic's spec
   * says "Deletes the directory and all its contents recursively" so
   * we use `rm -rf` semantics for directories.
   */
  async delete(agentId: string, virtualPath: string): Promise<string> {
    const t = this.translatePath(agentId, virtualPath);
    if (!t.ok) return `Error: ${t.error}`;
    const abs = t.abs;

    return this.withMutex(agentId, async () => {
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return `Error: The path ${virtualPath} does not exist`;
        }
        throw e;
      }
      if (stat.isDirectory()) {
        await fsp.rm(abs, { recursive: true, force: true });
      } else {
        await fsp.unlink(abs);
      }
      return `Successfully deleted ${virtualPath}`;
    });
  }

  // ── rename ───────────────────────────────────────────────────────────

  /**
   * `rename` — move or rename a file/directory. Errors if source is
   * missing or destination already exists (no overwrite).
   */
  async rename(
    agentId: string,
    oldVirtualPath: string,
    newVirtualPath: string
  ): Promise<string> {
    const t1 = this.translatePath(agentId, oldVirtualPath);
    if (!t1.ok) return `Error: ${t1.error.replace("does not exist. Please provide a valid path.", "does not exist")}`;
    const t2 = this.translatePath(agentId, newVirtualPath);
    if (!t2.ok) return `Error: ${t2.error.replace("does not exist. Please provide a valid path.", "does not exist")}`;

    return this.withMutex(agentId, async () => {
      try {
        await fsp.stat(t1.abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return `Error: The path ${oldVirtualPath} does not exist`;
        }
        throw e;
      }
      try {
        await fsp.stat(t2.abs);
        return `Error: The destination ${newVirtualPath} already exists`;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await fsp.mkdir(path.dirname(t2.abs), { recursive: true });
      await fsp.rename(t1.abs, t2.abs);
      return `Successfully renamed ${oldVirtualPath} to ${newVirtualPath}`;
    });
  }

  // ── Internals ────────────────────────────────────────────────────────

  /** Atomic write — tmp file + fsync + rename. */
  private async writeFileAtomic(absPath: string, content: string): Promise<void> {
    const dir = path.dirname(absPath);
    await fsp.mkdir(dir, { recursive: true });

    const tmp = path.join(
      dir,
      `${TMP_PREFIX}${randomBytes(8).toString("hex")}.tmp`
    );
    let fh: fsp.FileHandle | null = null;
    try {
      fh = await fsp.open(tmp, "w");
      await fh.writeFile(content, "utf-8");
      await fh.sync();
      await fh.close();
      fh = null;
      await fsp.rename(tmp, absPath);
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

// Export so tests can verify the line-numbering helper.
export const __test = { withLineNumbers, formatBytes, fmtLineNo };
