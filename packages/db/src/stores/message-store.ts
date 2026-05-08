import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { asc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { messages, type Message, type NewMessage } from "../schema.js";

export type { Message, NewMessage };

export interface SearchResult {
  content: string;
  sessionId: string;
  role: string;
  rank: number;
}

/**
 * Message store — drizzle ORM operations on `messages`, plus a raw FTS5
 * search statement (drizzle can't model virtual tables).
 */
export function createMessageStore(db: Database.Database) {
  const orm = drizzle(db);

  // FTS5 virtual tables aren't representable in drizzle's schema. The
  // search hot path stays on a cached better-sqlite3 prepared statement.
  const ftsSearchStmt = db.prepare(
    `SELECT content, session_id as sessionId, role, rank
     FROM fts_messages WHERE fts_messages MATCH ?
     ORDER BY rank LIMIT ?`
  );

  type Insertable = Omit<NewMessage, "id" | "createdAt">;

  function appendOne(sessionId: string, message: Insertable): Message {
    const id = randomUUID();
    return orm
      .insert(messages)
      .values({
        id,
        sessionId,
        role: message.role,
        content: message.content ?? null,
        toolCalls: message.toolCalls ?? null,
        toolCallId: message.toolCallId ?? null,
        toolName: message.toolName ?? null,
      })
      .returning()
      .get();
  }

  return {
    append(sessionId: string, message: Insertable): Message {
      return appendOne(sessionId, message);
    },

    /**
     * Bulk insert in a single transaction. Used by the compression fork
     * to copy the verbatim tail of an old session into the new child.
     * Drizzle's `transaction` wraps better-sqlite3's; a throw mid-batch
     * rolls back every row.
     */
    appendMany(sessionId: string, msgs: Insertable[]): Message[] {
      return orm.transaction((tx) => {
        const out: Message[] = [];
        for (const m of msgs) {
          const id = randomUUID();
          const row = tx
            .insert(messages)
            .values({
              id,
              sessionId,
              role: m.role,
              content: m.content ?? null,
              toolCalls: m.toolCalls ?? null,
              toolCallId: m.toolCallId ?? null,
              toolName: m.toolName ?? null,
            })
            .returning()
            .get();
          out.push(row);
        }
        return out;
      });
    },

    /**
     * Tie-break on rowid: created_at is unixepoch (second resolution), so
     * a tight bulk insert (e.g. compression fork copying tail messages)
     * can land rows with the same timestamp. Without an explicit rowid
     * tie-break, SQLite's row order for equal keys is undefined — and the
     * agent's history loader does an i+1 lookahead for tool-call /
     * tool-result pairing that breaks badly under reorder.
     */
    getHistory(sessionId: string): Message[] {
      return orm
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.createdAt), asc(sql`rowid`))
        .all();
    },

    /**
     * Full-text search across all messages using FTS5 with BM25 ranking.
     */
    search(query: string, limit = 20): SearchResult[] {
      try {
        return ftsSearchStmt.all(query, limit) as SearchResult[];
      } catch {
        // FTS5 query syntax errors — return empty results.
        return [];
      }
    },

    deleteBySession(sessionId: string): void {
      orm.delete(messages).where(eq(messages.sessionId, sessionId)).run();
    },
  };
}

export type MessageStore = ReturnType<typeof createMessageStore>;
