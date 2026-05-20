import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "@openacme/config/logger";
import { messages, sessions, type Session } from "../schema.js";

const log = createLogger("db.session-store");

export type { Session } from "../schema.js";

export interface SessionStoreOptions {
  /** Absolute path to <dataDir>/attachments. Used by `delete` to fan out
   *  filesystem cleanup after the cascading SQL delete. Optional only for
   *  tests/in-memory dbs where no files were ever written. */
  attachmentsRoot?: string;
  /** Fires after a row is deleted, with the session being removed. Used by
   *  callers (AgentManager) to fan out side-effect cleanup the db package
   *  shouldn't know about — e.g. spilled tool-call files under
   *  `<agentDir>/sessions/<sessionId>/`. Failures are caller-handled. */
  onAfterDelete?: (session: Session) => void;
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
  const onAfterDelete = options.onAfterDelete;

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
      const child = alias(sessions, "c");
      return orm
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.agentId, agentId),
            notExists(
              orm
                .select({ one: sql`1` })
                .from(child)
                .where(eq(child.parentSessionId, sessions.id))
            )
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
      const child = alias(sessions, "c");
      return orm
        .select()
        .from(sessions)
        .where(
          notExists(
            orm
              .select({ one: sql`1` })
              .from(child)
              .where(eq(child.parentSessionId, sessions.id))
          )
        )
        .orderBy(desc(sessions.updatedAt))
        .all();
    },

    /**
     * Compaction fork via rename-swap. Atomically:
     *   1. Mints a fresh uuid `archivedId`
     *   2. Inserts a new sessions row at `archivedId` carrying the
     *      original row's metadata (including its current
     *      `parent_session_id`, so a re-compress chain keeps linking).
     *   3. Moves all of the original session's messages under
     *      `archivedId`.
     *   4. Drops the original row (no rows reference it anymore — the
     *      messages just moved).
     *   5. Re-inserts a fresh row at the ORIGINAL id with
     *      `parent_session_id = archivedId`, `system_prompt = NULL`,
     *      and `defer_until` carried over from the original (so a
     *      standing defer survives compaction).
     *
     * Caller then appends compressed `[head + summary + tail]` messages
     * under the original id. External references that used the original
     * id (`task.session_id`, `agent_inbox.related_session`, the URL,
     * the dispatcher's `activeTurns` controller) keep pointing at the
     * right (post-compression) session with no migration step.
     *
     * Returns the new archived id; the original id is unchanged by
     * design.
     *
     * Throws if no row with `id = parentId` exists. Wrap the whole thing
     * in `orm.transaction(...)` so a failure mid-swap rolls back.
     */
    renameAndForkInTransaction(
      parentId: string,
      opts: { title?: string } = {}
    ): { archivedId: string; originalId: string } {
      return orm.transaction((tx) => {
        const parent = tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, parentId))
          .get();
        if (!parent) {
          throw new Error(
            `renameAndForkInTransaction: session ${parentId} not found`
          );
        }
        const archivedId = randomUUID();
        // 1. Insert the archived shell with the original's metadata.
        //    `parent_session_id` is inherited so the chain continues
        //    pointing further back (Y2 → Y → … → root) when this is
        //    a second-or-later compaction.
        tx
          .insert(sessions)
          .values({
            id: archivedId,
            agentId: parent.agentId,
            title: parent.title,
            systemPrompt: parent.systemPrompt,
            parentSessionId: parent.parentSessionId,
            // defer_until stays on the active row; archive doesn't need it
            deferUntil: null,
          })
          .run();
        // 2. Move parent's messages to the archive.
        tx
          .update(messages)
          .set({ sessionId: archivedId })
          .where(eq(messages.sessionId, parentId))
          .run();
        // 3. Drop the original row. Nothing FK's to it now.
        tx.delete(sessions).where(eq(sessions.id, parentId)).run();
        // 4. Re-insert at the original id, pointing at the archive.
        //    system_prompt cleared so the next turn rebuilds; defer
        //    carried over so any standing window survives compaction.
        tx
          .insert(sessions)
          .values({
            id: parentId,
            agentId: parent.agentId,
            title: opts.title ?? parent.title,
            systemPrompt: null,
            parentSessionId: archivedId,
            deferUntil: parent.deferUntil,
          })
          .run();
        return { archivedId, originalId: parentId };
      });
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
        .set({ title })
        .where(eq(sessions.id, id))
        .run();
    },

    updateSystemPrompt(id: string, systemPrompt: string): void {
      orm
        .update(sessions)
        .set({ systemPrompt })
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

    // `getLastSeenEventTs` / `markEventsSeen` removed. The per-
    // session cursor over the event log is gone — the agent inbox
    // (per-agent, delete-on-deliver) handles incrementality now.

    /** Set the sticky "skip routine spawns until this time" marker.
     *  The dispatcher honours this on its periodic tick, but a new
     *  inbox row for this session bypasses it (defer = "skip routine
     *  checks," not "ignore real signals"). Persists across signal-
     *  driven wakes until it naturally expires or a subsequent call
     *  replaces it. Caller is responsible for clamping `unixSeconds`
     *  to [now+60, now+86400]. */
    setDeferUntil(id: string, unixSeconds: number | null): void {
      const result = orm
        .update(sessions)
        .set({ deferUntil: unixSeconds })
        .where(eq(sessions.id, id))
        .run();
      if (result.changes === 0) {
        log.warn(
          { sessionId: id },
          "setDeferUntil: session not found — value not stored"
        );
      }
    },

    getDeferUntil(id: string): number | null {
      const row = orm
        .select({ ts: sessions.deferUntil })
        .from(sessions)
        .where(eq(sessions.id, id))
        .get();
      return row?.ts ?? null;
    },

    clearDeferUntil(id: string): void {
      orm
        .update(sessions)
        .set({ deferUntil: null })
        .where(eq(sessions.id, id))
        .run();
    },

    delete(id: string): void {
      // FK cascade clears messages and message_attachments; the on-disk
      // attachment files don't have a trigger, so we rm them explicitly.
      // Order is "fetch row, SQL delete, FS cleanup" — the row read has
      // to happen before deletion so onAfterDelete still sees agentId etc.
      const row = orm
        .select()
        .from(sessions)
        .where(eq(sessions.id, id))
        .get();
      orm.delete(sessions).where(eq(sessions.id, id)).run();
      if (attachmentsRoot) {
        const dir = path.join(attachmentsRoot, id);
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (e) {
          log.error({ err: e, dir }, "failed to remove attachment dir");
        }
      }
      if (row && onAfterDelete) {
        try {
          onAfterDelete(row);
        } catch (e) {
          log.error({ err: e, sessionId: id }, "onAfterDelete hook threw");
        }
      }
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
