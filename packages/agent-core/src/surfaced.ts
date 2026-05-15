/**
 * `alreadySurfaced` tracking. Scans message history (not Agent state)
 * so compaction naturally resets — old attachments are gone from the
 * compacted view, so re-surfacing becomes valid again.
 */

import type { UIMessage } from "ai";

export interface SurfacedSnapshot {
  paths: Set<string>;
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

/** Reset hook for autonomous trigger boundaries. Today a no-op. */
export function resetForActivation(): void {}
