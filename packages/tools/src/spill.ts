import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "@openacme/config/logger";
import { toolCallContext } from "./session-context.js";
import type { ToolEntry } from "./types.js";

const log = createLogger("tools.spill");

/** Tools without an explicit `maxResultSizeChars` spill above this size. */
export const DEFAULT_SPILL_THRESHOLD = 25_000;
/** First-N chars of the full result kept inline as a preview. */
export const PREVIEW_CHARS = 2_000;
/** Per-session subdir under `<agentDir>/sessions/<sessionId>/` where every
 *  spilled tool result + auto-snapshot lands. Picked over a workspace-local
 *  hidden dir so spill files don't pollute the agent's cwd listing and
 *  cleanup can scope precisely to a session. */
export const TOOL_CALLS_DIR = "tool-calls";

/** Resolve `<agentDir>/sessions/<sessionId>/tool-calls` for the active tool
 *  call. `workspaceDir` is `<agentDir>/workspace`, so the agent dir is its
 *  parent. Returns null if no workspace context (test/script paths). */
export function resolveToolCallsDir(): string | null {
  const ctx = toolCallContext.getStore();
  if (!ctx?.workspaceDir) return null;
  const agentDir = path.dirname(ctx.workspaceDir);
  return path.join(agentDir, "sessions", ctx.sessionId, TOOL_CALLS_DIR);
}

/**
 * Inspect a tool result. If it exceeds the per-tool (or default) threshold,
 * write the full body to `<agentDir>/sessions/<sessionId>/tool-calls/...`
 * and return a preview + path-pointing trailer; the agent can then use
 * `read_file`, `search_files`, or shell (`grep`, `head`, `tail`) to navigate.
 * Otherwise return the result unchanged.
 *
 * Falls back to returning the result verbatim if workspace context is
 * unavailable (tool called outside an agent turn — tests, scripts).
 */
export async function maybeSpill(
  result: string,
  entry: ToolEntry
): Promise<string> {
  if (entry.binaryResult) return result;
  const threshold = entry.maxResultSizeChars ?? DEFAULT_SPILL_THRESHOLD;
  if (result.length <= threshold) return result;

  const dir = resolveToolCallsDir();
  if (!dir) return result; // no spill destination — pass through

  const filename = spillFilename(entry.name);
  const absPath = path.join(dir, filename);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, result, "utf-8");
  } catch (err) {
    log.warn(
      { err, tool: entry.name, dir },
      "spill write failed — returning result verbatim"
    );
    return result;
  }

  const preview = result.slice(0, PREVIEW_CHARS);
  const sizeLabel = humanBytes(result.length);
  return (
    preview +
    `\n\n[overflow: ${sizeLabel} total — full result at ${absPath}. ` +
    `Use read_file, search_files, or shell grep/head/tail on that absolute path to navigate.]`
  );
}

function spillFilename(toolName: string): string {
  const ts = isoTimestamp();
  const rand = randomBytes(2).toString("hex");
  const safeTool = toolName.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${ts}-${safeTool}-${rand}.txt`;
}

/**
 * Unconditionally write a snapshot string to the active session's
 * tool-calls dir and return its absolute path. Matches Microsoft's
 * playwright-mcp convention — every snapshot is delivered as a file link
 * in the tool response, so the model can `read_file` / `search_files` on
 * demand without burning inline context on YAML that's often hundreds of KB.
 *
 * Returns the absolute path on success, or `null` if no workspace context
 * is available or the write fails — callers then fall back to inlining
 * the snapshot string verbatim.
 */
export function spillSnapshot(yaml: string): string | null {
  const dir = resolveToolCallsDir();
  if (!dir) return null;
  const filename = `snapshot-${isoTimestamp()}-${randomBytes(2).toString("hex")}.yml`;
  const absPath = path.join(dir, filename);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, yaml, "utf-8");
  } catch (err) {
    log.warn({ err, dir }, "spillSnapshot write failed — falling back to inline");
    return null;
  }
  return absPath;
}

function isoTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Walk every agent's `<agentDir>/sessions/*\/tool-calls/` and delete files
 * older than `maxAgeMs` (default 30 days). Empty session dirs left behind
 * by the sweep are removed too, so a `sessions/` listing stays clean.
 *
 * Bounded one-shot — daemon startup calls this once; no periodic timer.
 * Failures on individual files are logged and skipped. The 30-day window
 * is generous so an agent that referenced a spill file in a long-running
 * task still finds it on the next wake.
 */
export function sweepOverflow(
  agentsRoot: string,
  maxAgeMs: number = 30 * 24 * 60 * 60 * 1000
): { removed: number; bytes: number } {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let bytes = 0;
  let agents: string[];
  try {
    agents = fs.readdirSync(agentsRoot);
  } catch {
    return { removed, bytes };
  }
  for (const agentId of agents) {
    const sessionsRoot = path.join(agentsRoot, agentId, "sessions");
    let sessions: string[];
    try {
      sessions = fs.readdirSync(sessionsRoot);
    } catch {
      continue;
    }
    for (const sessionId of sessions) {
      const dir = path.join(sessionsRoot, sessionId, TOOL_CALLS_DIR);
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const p = path.join(dir, f);
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs < cutoff) {
            bytes += st.size;
            fs.unlinkSync(p);
            removed++;
          }
        } catch (err) {
          log.warn({ err, path: p }, "spill sweep: failed to inspect/remove");
        }
      }
      // Best-effort: drop the tool-calls dir + its session parent if both
      // are empty now, so stale sessions don't leave empty shells behind.
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        const sessDir = path.join(sessionsRoot, sessionId);
        if (fs.readdirSync(sessDir).length === 0) fs.rmdirSync(sessDir);
      } catch {
        // dir not empty or already gone — fine
      }
    }
  }
  return { removed, bytes };
}

/**
 * Remove a single session's `tool-calls/` (and its parent session dir if
 * empty after). Called from SessionStore.delete so per-session spill files
 * cascade away with the session row. Best-effort: missing dirs are silent.
 */
export function deleteSessionToolCalls(
  agentsDir: string,
  agentId: string,
  sessionId: string
): void {
  const dir = path.join(agentsDir, agentId, "sessions", sessionId, TOOL_CALLS_DIR);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, dir }, "deleteSessionToolCalls failed");
  }
  // If the session subdir is now empty, drop it too.
  const sessDir = path.join(agentsDir, agentId, "sessions", sessionId);
  try {
    if (fs.readdirSync(sessDir).length === 0) fs.rmdirSync(sessDir);
  } catch {
    // not empty or missing — fine
  }
}
