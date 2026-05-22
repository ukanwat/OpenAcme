import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { asc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { messages, type NewMessageRow } from "../schema.js";

/**
 * Persisted UIMessage shape. The store is type-agnostic about what's
 * inside `parts` — agent-core casts to `UIMessagePart[]` from `ai`.
 * Keeps the db package free of the SDK dep.
 */
export interface StoredUIMessage {
  id: string;
  role: "user" | "assistant";
  parts: unknown[];
  metadata?: unknown;
  /** Persistence timestamp (unix seconds). Populated by `getHistory` /
   *  `append`; the row's DB-assigned `created_at`. Surfaced so callers
   *  that render history (web chat, CLI, audit) can show timing without
   *  a separate query. */
  createdAt?: number;
}

export interface SearchResult {
  content: string;
  sessionId: string;
  role: string;
  rank: number;
}

/**
 * Message store — drizzle ops on `messages`. One row per UIMessage;
 * `parts` is JSON-stringified on write, parsed on read.
 *
 * The pre-UIMessage shape (per-step rows with content + tool_calls JSON
 * + tool_call_id + tool_name) is gone. Tool calls + their results live
 * inside an assistant UIMessage's `parts` as `tool-${name}` parts —
 * structural pairing, no orphan-row problem.
 */
export function createMessageStore(db: Database.Database) {
  const orm = drizzle(db);

  const ftsSearchStmt = db.prepare(
    `SELECT content, session_id as sessionId, role, rank
     FROM fts_messages WHERE fts_messages MATCH ?
     ORDER BY rank LIMIT ?`
  );

  // Per-agent variant: join through sessions to filter on agent_id.
  // Sessions are agent-scoped, messages are session-scoped, so we can
  // reach agent_id with one join. The compression-fork chain (parent_session_id)
  // stays inside the same agent_id by construction, so a plain equality
  // filter is sufficient — no recursive walk needed.
  const ftsSearchByAgentStmt = db.prepare(
    `SELECT fm.content AS content, fm.session_id AS sessionId, fm.role AS role, fm.rank AS rank
     FROM fts_messages fm
     JOIN sessions s ON s.id = fm.session_id
     WHERE fts_messages MATCH ? AND s.agent_id = ?
     ORDER BY fm.rank LIMIT ?`
  );

  function rowToMessage(row: {
    id: string;
    role: string;
    parts: string;
    metadata: string | null;
    createdAt: number;
  }): StoredUIMessage {
    return {
      id: row.id,
      role: row.role as "user" | "assistant",
      parts: JSON.parse(row.parts) as unknown[],
      metadata:
        row.metadata !== null && row.metadata !== ""
          ? (JSON.parse(row.metadata) as unknown)
          : undefined,
      createdAt: row.createdAt,
    };
  }

  function toInsert(
    sessionId: string,
    m: StoredUIMessage
  ): NewMessageRow {
    return {
      id: m.id || randomUUID(),
      sessionId,
      role: m.role,
      parts: JSON.stringify(m.parts),
      metadata:
        m.metadata !== undefined ? JSON.stringify(m.metadata) : null,
    };
  }

  return {
    /** Persist one UIMessage. Caller MUST pass the id the SDK emitted. */
    append(sessionId: string, message: StoredUIMessage): StoredUIMessage {
      const row = orm
        .insert(messages)
        .values(toInsert(sessionId, message))
        .returning()
        .get();
      return rowToMessage(row);
    },

    /**
     * Bulk insert in one transaction. Used by the compression child
     * write so all-or-nothing failure is preserved.
     */
    appendMany(
      sessionId: string,
      msgs: StoredUIMessage[]
    ): StoredUIMessage[] {
      return orm.transaction((tx) => {
        const out: StoredUIMessage[] = [];
        for (const m of msgs) {
          const row = tx
            .insert(messages)
            .values(toInsert(sessionId, m))
            .returning()
            .get();
          out.push(rowToMessage(row));
        }
        return out;
      });
    },

    /**
     * Tie-break on rowid alongside created_at: same-second bulk inserts
     * (the compression fork copies messages in one tight loop) need a
     * stable secondary sort. Loss of the rowid tie-break would leave
     * SQLite free to return rows in arbitrary order for equal keys.
     */
    getHistory(sessionId: string): StoredUIMessage[] {
      return orm
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.createdAt), asc(sql`rowid`))
        .all()
        .map(rowToMessage);
    },

    /**
     * Full-text search using FTS5 with BM25 ranking. Pass `agentId` to scope
     * results to one agent's sessions (workforce-isolation default for the
     * `session_search` tool — an agent's long-term memory should not leak
     * coworkers' conversations). Omit to search across all sessions
     * (admin / cross-agent use only).
     */
    search(query: string, limit = 20, agentId?: string): SearchResult[] {
      try {
        if (agentId) {
          return ftsSearchByAgentStmt.all(
            query,
            agentId,
            limit
          ) as SearchResult[];
        }
        return ftsSearchStmt.all(query, limit) as SearchResult[];
      } catch {
        return [];
      }
    },

    deleteBySession(sessionId: string): void {
      orm.delete(messages).where(eq(messages.sessionId, sessionId)).run();
    },
  };
}

export type MessageStore = ReturnType<typeof createMessageStore>;
