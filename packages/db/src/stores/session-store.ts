import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { sessions, type Session } from "../schema.js";

export type { Session } from "../schema.js";

/**
 * Session store — drizzle ORM operations on `sessions`.
 *
 * One unconventional method: `createChildIfNoSibling` uses a raw `sql`
 * template to keep the atomic `INSERT ... WHERE NOT EXISTS` pattern. The
 * drizzle high-level API can't express this without adding a `UNIQUE`
 * constraint on `parent_session_id` (which would mean another migration).
 * The race-safety story is documented inline.
 */
export function createSessionStore(db: Database.Database) {
  const orm = drizzle(db);

  return {
    create(
      agentId: string,
      opts: { id?: string; title?: string; parentSessionId?: string } = {}
    ): Session {
      const id = opts.id ?? randomUUID();
      return orm
        .insert(sessions)
        .values({
          id,
          agentId,
          title: opts.title ?? null,
          systemPrompt: null,
          parentSessionId: opts.parentSessionId ?? null,
        })
        .returning()
        .get();
    },

    /**
     * Insert a child session, but only if no row already references this
     * parent. Returns the new child, or null if another writer beat us
     * (caller should then `findChildOf` to get the existing one).
     *
     * Implemented with `INSERT ... SELECT ... WHERE NOT EXISTS` so the
     * "no sibling" check and the insert are a single SQLite operation —
     * cross-process safe even without a UNIQUE constraint on
     * parent_session_id. A drizzle transaction with separate SELECT then
     * INSERT would race under DEFERRED locking.
     */
    createChildIfNoSibling(
      agentId: string,
      parentSessionId: string,
      opts: { id?: string; title?: string } = {}
    ): Session | null {
      const id = opts.id ?? randomUUID();
      const result = orm.run(sql`
        INSERT INTO ${sessions} (id, agent_id, title, system_prompt, parent_session_id, created_at, updated_at)
        SELECT ${id}, ${agentId}, ${opts.title ?? null}, NULL, ${parentSessionId}, unixepoch(), unixepoch()
        WHERE NOT EXISTS (SELECT 1 FROM ${sessions} WHERE parent_session_id = ${parentSessionId})
      `);
      if (result.changes === 0) return null;
      return (
        orm.select().from(sessions).where(eq(sessions.id, id)).get() ?? null
      );
    },

    get(id: string): Session | null {
      return orm.select().from(sessions).where(eq(sessions.id, id)).get() ?? null;
    },

    list(agentId: string): Session[] {
      return orm
        .select()
        .from(sessions)
        .where(eq(sessions.agentId, agentId))
        .orderBy(desc(sessions.updatedAt))
        .all();
    },

    /**
     * Active = the leaf of every compression chain. A session is hidden
     * once it has been forked (some other session points at it as parent),
     * because the child takes over as the active conversation. Children
     * themselves remain visible — they ARE the live session.
     */
    listActive(agentId: string): Session[] {
      return orm
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.agentId, agentId),
            sql`NOT EXISTS (SELECT 1 FROM ${sessions} c WHERE c.parent_session_id = ${sessions.id})`
          )
        )
        .orderBy(desc(sessions.updatedAt))
        .all();
    },

    /**
     * Cross-agent variant of `listActive` — every leaf session in the
     * compression chain across all agents, newest first. Powers the CLI's
     * `/sessions` picker, which lets the user resume any past conversation
     * regardless of which agent owns it.
     */
    listAllActive(): Session[] {
      return orm
        .select()
        .from(sessions)
        .where(
          sql`NOT EXISTS (SELECT 1 FROM ${sessions} c WHERE c.parent_session_id = ${sessions.id})`
        )
        .orderBy(desc(sessions.updatedAt))
        .all();
    },

    findChildOf(parentSessionId: string): Session | null {
      return (
        orm
          .select()
          .from(sessions)
          .where(eq(sessions.parentSessionId, parentSessionId))
          .limit(1)
          .get() ?? null
      );
    },

    updateTitle(id: string, title: string): void {
      orm
        .update(sessions)
        .set({ title, updatedAt: sql`(unixepoch())` })
        .where(eq(sessions.id, id))
        .run();
    },

    updateSystemPrompt(id: string, systemPrompt: string): void {
      orm
        .update(sessions)
        .set({ systemPrompt, updatedAt: sql`(unixepoch())` })
        .where(eq(sessions.id, id))
        .run();
    },

    touch(id: string): void {
      orm
        .update(sessions)
        .set({ updatedAt: sql`(unixepoch())` })
        .where(eq(sessions.id, id))
        .run();
    },

    delete(id: string): void {
      orm.delete(sessions).where(eq(sessions.id, id)).run();
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
