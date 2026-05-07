import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface Session {
  id: string;
  agentId: string;
  title: string | null;
  systemPrompt: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Session store — CRUD operations for chat sessions.
 */
export function createSessionStore(db: Database.Database) {
  const stmts = {
    insert: db.prepare(
      `INSERT INTO sessions (id, agent_id, title, system_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, unixepoch(), unixepoch())`
    ),
    get: db.prepare(
      `SELECT id, agent_id as agentId, title, system_prompt as systemPrompt,
              created_at as createdAt, updated_at as updatedAt
       FROM sessions WHERE id = ?`
    ),
    list: db.prepare(
      `SELECT id, agent_id as agentId, title, system_prompt as systemPrompt,
              created_at as createdAt, updated_at as updatedAt
       FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC`
    ),
    updateTitle: db.prepare(
      `UPDATE sessions SET title = ?, updated_at = unixepoch() WHERE id = ?`
    ),
    updateSystemPrompt: db.prepare(
      `UPDATE sessions SET system_prompt = ?, updated_at = unixepoch() WHERE id = ?`
    ),
    touch: db.prepare(
      `UPDATE sessions SET updated_at = unixepoch() WHERE id = ?`
    ),
    delete: db.prepare(`DELETE FROM sessions WHERE id = ?`),
  };

  return {
    create(agentId: string, title?: string): Session {
      const id = randomUUID();
      stmts.insert.run(id, agentId, title ?? null, null);
      return stmts.get.get(id) as Session;
    },

    get(id: string): Session | null {
      return (stmts.get.get(id) as Session) ?? null;
    },

    list(agentId: string): Session[] {
      return stmts.list.all(agentId) as Session[];
    },

    updateTitle(id: string, title: string): void {
      stmts.updateTitle.run(title, id);
    },

    updateSystemPrompt(id: string, systemPrompt: string): void {
      stmts.updateSystemPrompt.run(systemPrompt, id);
    },

    touch(id: string): void {
      stmts.touch.run(id);
    },

    delete(id: string): void {
      stmts.delete.run(id);
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
