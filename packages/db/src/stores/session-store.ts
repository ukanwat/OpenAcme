import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { sessions, type Session } from "../schema.js";

export type { Session } from "../schema.js";

export interface SessionStoreOptions {
  /** Absolute path to <dataDir>/attachments. Used by `delete` to fan out
   *  filesystem cleanup after the cascading SQL delete. Optional only for
   *  tests/in-memory dbs where no files were ever written. */
  attachmentsRoot?: string;
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
export function createSessionStore(
  db: Database.Database,
  options: SessionStoreOptions = {}
) {
  const orm = drizzle(db);
  const attachmentsRoot = options.attachmentsRoot;

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

    /**
     * Walk `parent_session_id` to the root of the compression chain.
     * Returns the input id if the session has no parent (or doesn't exist —
     * caller's responsibility to validate the input). Cycle-safe via a
     * visited set; a malformed graph short-circuits at the first repeat.
     *
     * Used by `session_search` to (a) collapse a chain of compression forks
     * into one hit and (b) recognize the current conversation across
     * compression boundaries so the agent doesn't surface its own pre-fork
     * messages as cross-session memory.
     */
    getRoot(sessionId: string): string {
      let current = sessionId;
      const visited = new Set<string>();
      while (!visited.has(current)) {
        visited.add(current);
        const row = orm
          .select({ parentSessionId: sessions.parentSessionId })
          .from(sessions)
          .where(eq(sessions.id, current))
          .get();
        if (!row || !row.parentSessionId) return current;
        current = row.parentSessionId;
      }
      return current;
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

    /** Read-state cursor for the session's events inbox. Backfilled to
     *  `unixepoch()` at migration time for existing sessions; new
     *  sessions also default to `unixepoch()` on insert. Advanced at
     *  the end of every autonomous turn to the max event ts actually
     *  rendered (avoids losing events that landed in the same second). */
    getLastSeenEventTs(id: string): number | null {
      const row = orm
        .select({ ts: sessions.lastSeenEventTs })
        .from(sessions)
        .where(eq(sessions.id, id))
        .get();
      return row ? row.ts : null;
    },

    markEventsSeen(id: string, ts?: number): void {
      const result = orm
        .update(sessions)
        .set({
          lastSeenEventTs: ts ?? sql`(unixepoch())`,
        })
        .where(eq(sessions.id, id))
        .run();
      if (result.changes === 0) {
        console.warn(
          `markEventsSeen: session ${id} not found — cursor not advanced`
        );
      }
    },

    delete(id: string): void {
      // FK cascade clears messages and message_attachments; the on-disk
      // attachment files don't have a trigger, so we rm them explicitly.
      // Order is "SQL first, FS second" because if SQL fails the files
      // are still referenced; if FS fails the rows are already gone and
      // the orphan files are harmless until the next sweep.
      orm.delete(sessions).where(eq(sessions.id, id)).run();
      if (attachmentsRoot) {
        const dir = path.join(attachmentsRoot, id);
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (e) {
          console.error(
            `Failed to remove attachment dir ${dir}: ${
              e instanceof Error ? e.message : String(e)
            }`
          );
        }
      }
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
