import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { sessions, type Session as SessionRow } from "../schema.js";

/**
 * Public Session shape — drizzle returns `compression_pending` as integer
 * (0|1) because mode: "boolean" would force a table-rebuild migration over
 * a cosmetic default-literal change. We hydrate the integer to a boolean
 * at the API boundary so callers don't have to.
 */
export interface Session extends Omit<SessionRow, "compressionPending"> {
  compressionPending: boolean;
}

function hydrate(row: SessionRow): Session;
function hydrate(row: SessionRow | undefined): Session | null;
function hydrate(row: SessionRow | undefined): Session | null {
  if (!row) return null;
  return { ...row, compressionPending: row.compressionPending === 1 };
}

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
      const inserted = orm
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
      return hydrate(inserted);
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
      const row = orm
        .select()
        .from(sessions)
        .where(eq(sessions.id, id))
        .get();
      return hydrate(row);
    },

    get(id: string): Session | null {
      return hydrate(
        orm.select().from(sessions).where(eq(sessions.id, id)).get()
      );
    },

    list(agentId: string): Session[] {
      return orm
        .select()
        .from(sessions)
        .where(eq(sessions.agentId, agentId))
        .orderBy(desc(sessions.updatedAt))
        .all()
        .map((r) => hydrate(r));
    },

    /**
     * Active = the leaf of every compression chain. A session is hidden
     * once it has been forked (some other session points at it as parent),
     * because the child takes over as the active conversation. Children
     * themselves remain visible — they ARE the live session.
     *
     * Uses a correlated NOT EXISTS subquery — drizzle can express this
     * with `notExists` + an aliased table, but the resulting builder code
     * is noisier than the SQL it emits. Inline `sql` is clearer here.
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
        .all()
        .map((r) => hydrate(r));
    },

    findChildOf(parentSessionId: string): Session | null {
      return hydrate(
        orm
          .select()
          .from(sessions)
          .where(eq(sessions.parentSessionId, parentSessionId))
          .limit(1)
          .get()
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

    markCompressionPending(id: string): void {
      orm
        .update(sessions)
        .set({ compressionPending: 1 })
        .where(eq(sessions.id, id))
        .run();
    },

    clearCompressionPending(id: string): void {
      orm
        .update(sessions)
        .set({ compressionPending: 0 })
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
