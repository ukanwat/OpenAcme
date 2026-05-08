import { z } from "zod";
import { registry } from "../registry.js";

export interface SessionSearchHit {
  content: string;
  sessionId: string;
  role: string;
  rank: number;
}

export type SessionSearchFn = (
  query: string,
  limit?: number
) => SessionSearchHit[];

// Bound at runtime by AgentManager so this package stays free of a runtime
// dependency on @openacme/db (avoids a circular: db → tools → db). Until
// `bindSessionSearch` is called, the tool reports a clear error rather than
// silently returning empty results.
let searchFn: SessionSearchFn | null = null;

export function bindSessionSearch(fn: SessionSearchFn): void {
  searchFn = fn;
}

registry.register({
  name: "session_search",
  toolset: "memory",
  description:
    "Full-text search across all prior conversation messages (FTS5/BM25). " +
    "Use to recall earlier context the user mentioned in another session.",
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
    const { query, limit } = args as { query: string; limit?: number };
    if (!searchFn) {
      return JSON.stringify({
        error:
          "session_search not initialized — AgentManager must call bindSessionSearch().",
      });
    }
    const results = searchFn(query, limit ?? 10);
    return JSON.stringify({ success: true, query, count: results.length, results });
  },
});
