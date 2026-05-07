import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface Message {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
  createdAt: number;
}

export interface SearchResult {
  content: string;
  sessionId: string;
  role: string;
  rank: number;
}

/**
 * Message store — append messages, retrieve history, and FTS5 search.
 */
export function createMessageStore(db: Database.Database) {
  const stmts = {
    insert: db.prepare(
      `INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch())`
    ),
    getHistory: db.prepare(
      `SELECT id, session_id as sessionId, role, content, tool_calls as toolCalls,
              tool_call_id as toolCallId, created_at as createdAt
       FROM messages WHERE session_id = ? ORDER BY created_at ASC`
    ),
    search: db.prepare(
      `SELECT content, session_id as sessionId, role, rank
       FROM fts_messages WHERE fts_messages MATCH ?
       ORDER BY rank LIMIT ?`
    ),
    delete: db.prepare(`DELETE FROM messages WHERE session_id = ?`),
  };

  return {
    append(sessionId: string, message: Omit<Message, "id" | "createdAt">): Message {
      const id = randomUUID();
      stmts.insert.run(
        id,
        sessionId,
        message.role,
        message.content ?? null,
        message.toolCalls ?? null,
        message.toolCallId ?? null
      );
      return { id, createdAt: Math.floor(Date.now() / 1000), ...message, sessionId };
    },

    getHistory(sessionId: string): Message[] {
      return stmts.getHistory.all(sessionId) as Message[];
    },

    /**
     * Full-text search across all messages using FTS5 with BM25 ranking.
     */
    search(query: string, limit = 20): SearchResult[] {
      try {
        return stmts.search.all(query, limit) as SearchResult[];
      } catch {
        // FTS5 query syntax errors — return empty results
        return [];
      }
    },

    deleteBySession(sessionId: string): void {
      stmts.delete.run(sessionId);
    },
  };
}

export type MessageStore = ReturnType<typeof createMessageStore>;
