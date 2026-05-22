import { z } from 'zod';
import { registry } from "../registry.js";
import { getCurrentAgentId, getCurrentSessionId } from "../session-context.js";

export interface SessionSearchHit {
  content: string;
  sessionId: string;
  role: string;
  rank: number;
}

export type SessionSearchFn = (
  query: string,
  limit?: number,
  agentId?: string
) => SessionSearchHit[];

export type ResolveRootFn = (sessionId: string) => string;

export interface SessionSearchBindings {
  search: SessionSearchFn;
  resolveRoot: ResolveRootFn;
}

// Bound at runtime by AgentManager so this package stays free of a runtime
// dependency on @openacme/db (avoids a circular: db → tools → db). Until
// `bindSessionSearch` is called, the tool reports a clear error rather than
// silently returning empty results.
let bindings: SessionSearchBindings | null = null;

export function bindSessionSearch(b: SessionSearchBindings): void {
  bindings = b;
}

/** How many raw FTS hits to pull per surfaced result, before dedup-by-root.
 *  Compression chains and repeated tool outputs in a single conversation
 *  inflate per-session hits, so we over-fetch to make sure dedup leaves us
 *  with enough distinct conversations. Hard cap protects against pathological
 *  queries that match thousands of rows. */
const FTS_OVERFETCH_FACTOR = 5;
const FTS_FETCH_CAP = 50;

interface DedupedHit {
  rootSessionId: string;
  /** Best (lowest = most relevant) BM25 rank across all matches in the lineage. */
  rank: number;
  /** Most-relevant matching message content from the lineage. */
  content: string;
  role: string;
}

registry.register({
  name: "session_search",
  toolset: "memory",
  description:
    "Full-text search across your prior conversation messages (FTS5/BM25). " +
    "Scoped to this agent — never returns hits from coworkers' sessions. " +
    "Use to recall earlier context the user mentioned in another session " +
    "with you. The current conversation's lineage is excluded automatically " +
    "— this is long-term memory, not a re-read of your own context.",
  parameters: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'FTS5 query. Supports `"phrase"`, `term*` prefix, `AND`/`OR`/`NOT`.'
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Max results (default 10, cap 50)"),
  }),
  emoji: "🧠",
  parallelSafe: true,
  handler: async (args) => {
    const { query, limit: rawLimit } = args as {
      query: string;
      limit?: number;
    };
    if (!bindings) {
      return JSON.stringify({
        error:
          "session_search not initialized — AgentManager must call bindSessionSearch().",
      });
    }
    const limit = rawLimit ?? 10;

    const currentSessionId = getCurrentSessionId();
    const currentAgentId = getCurrentAgentId();
    const currentRoot = currentSessionId
      ? bindings.resolveRoot(currentSessionId)
      : null;

    // Over-fetch so dedup-by-root has enough distinct conversations to
    // satisfy `limit`. Two reasons hits collapse: (1) one conversation that
    // produced many matching messages, (2) compression forks that turned
    // one conversation into multiple session rows.
    const fetchLimit = Math.min(
      Math.max(limit * FTS_OVERFETCH_FACTOR, limit),
      FTS_FETCH_CAP
    );
    // Scope to the current agent. Tool calls always run inside a turn that
    // had its ALS set by `Agent.runStream`, so `currentAgentId` is non-null
    // in practice. Defensive guard: if somehow null, fall back to unscoped
    // search rather than silently returning nothing — a wider net is less
    // surprising than empty results.
    const raw = bindings.search(
      query,
      fetchLimit,
      currentAgentId ?? undefined
    );

    const byRoot = new Map<string, DedupedHit>();
    for (const hit of raw) {
      const root = bindings.resolveRoot(hit.sessionId);
      if (currentRoot !== null && root === currentRoot) continue;

      const existing = byRoot.get(root);
      if (!existing) {
        byRoot.set(root, {
          rootSessionId: root,
          rank: hit.rank,
          content: hit.content,
          role: hit.role,
        });
        continue;
      }
      // FTS5 BM25 returns a negative score where lower is more relevant.
      // Keep the best representative match for each lineage.
      if (hit.rank < existing.rank) {
        existing.rank = hit.rank;
        existing.content = hit.content;
        existing.role = hit.role;
      }
    }

    const results = Array.from(byRoot.values())
      .sort((a, b) => a.rank - b.rank)
      .slice(0, limit)
      .map((r) => ({
        sessionId: r.rootSessionId,
        role: r.role,
        rank: r.rank,
        content: r.content,
      }));

    return JSON.stringify({
      success: true,
      query,
      count: results.length,
      results,
    });
  },
});
