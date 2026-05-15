/**
 * `alreadySurfaced` tracking for the recall selector.
 *
 * Walks the session's UIMessage history, picks up prior
 * `data-relevant-memory` parts (the persistent data part the selector
 * emits), and returns the set of paths + cumulative bytes already
 * shown. Phase-2 design — see plan §G.
 *
 * Why scan messages instead of holding state on the Agent: matches
 * Claude Code's exact note — *"Scanning messages rather than tracking
 * in toolUseContext means compact naturally resets both — old
 * attachments are gone from the compacted transcript, so re-surfacing
 * is valid again."* For OpenAcme that means a child session post-
 * compression starts with an empty surfaced set without any explicit
 * reset.
 *
 * Autonomous-future: a new task / cron / peer-message activation can
 * call `resetForActivation` to drop the surfaced set even mid-session,
 * since the trigger boundary is the right reset point in those modes.
 * Today nothing wires this up — the message-scan implicitly resets on
 * compaction, which is the only mechanism that exists.
 */

import type { UIMessage } from "ai";

export interface SurfacedSnapshot {
  /** Absolute file paths that have appeared in prior surfacings this session. */
  paths: Set<string>;
  /** Total bytes across those entries — surface for future budget gating. */
  totalBytes: number;
}

interface RelevantMemoryEntry {
  path: string;
  mtimeMs: number;
  content: string;
}

interface RelevantMemoryData {
  entries: RelevantMemoryEntry[];
}

/**
 * Walk the supplied UIMessage history and gather paths from any
 * persisted `data-relevant-memory` parts. Order doesn't matter — the
 * caller treats the result as a Set.
 */
export function collectSurfacedMemories(
  messages: readonly UIMessage[]
): SurfacedSnapshot {
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const m of messages) {
    if (!Array.isArray(m.parts)) continue;
    for (const part of m.parts) {
      const p = part as { type?: unknown; data?: unknown };
      if (p.type !== "data-relevant-memory") continue;
      const data = p.data as RelevantMemoryData | undefined;
      const entries = data?.entries;
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        if (typeof e?.path !== "string") continue;
        paths.add(e.path);
        if (typeof e.content === "string") {
          totalBytes += Buffer.byteLength(e.content, "utf-8");
        }
      }
    }
  }
  return { paths, totalBytes };
}

/**
 * Activation-cycle reset hook. Today a no-op (the message-scan picks
 * up the post-compaction transcript without help), but exposed so the
 * autonomous loop can drop the surfaced set at trigger boundaries when
 * we wire that up.
 */
export function resetForActivation(): void {
  /* placeholder — see header comment */
}
