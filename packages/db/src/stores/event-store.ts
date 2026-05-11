import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, desc, gt, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { taskEvents, type TaskEventRow } from "../schema.js";

export type { TaskEventRow } from "../schema.js";

// Single source of truth for `EventKind` is `@openacme/tasks/ports`.
import type { EventKind } from "@openacme/tasks";

export interface EventInput {
  taskId: string;
  agentId: string;
  /** Agent that *caused* this event. Used both for prompt attribution
   *  ("X commented", "Y closed") and for the scheduler's echo
   *  suppression — a session never wakes from its owning agent's own
   *  actions. Null/undefined = anonymous / system / auto, always wakes. */
  actor?: string | null;
  kind: EventKind;
  payload?: unknown;
  id?: string;
}

export type EventListener = (event: TaskEventRow) => void;

/**
 * Append-only event log driving the agent's "Recent activity" prompt
 * surface and the scheduler's wake decisions. No explicit recipient —
 * involvement is computed at read time from the caller's task ID set.
 *
 * `onEmit` listeners fire synchronously after each insert. They MUST
 * NOT synchronously emit further events (no re-entrancy guard) and
 * MUST NOT throw — a misbehaving listener gets logged and skipped so
 * one bad subscriber doesn't break event flow.
 */
export function createEventStore(db: Database.Database) {
  const orm = drizzle(db);
  const listeners: EventListener[] = [];
  let firing = false;

  return {
    append(input: EventInput): TaskEventRow {
      const row = orm
        .insert(taskEvents)
        .values({
          id: input.id ?? randomUUID(),
          taskId: input.taskId,
          agentId: input.agentId,
          actor: input.actor ?? null,
          kind: input.kind,
          payload: input.payload !== undefined ? JSON.stringify(input.payload) : null,
        })
        .returning()
        .get();
      // Re-entrancy guard: if a listener somehow triggers another append,
      // queue it as a microtask so we don't recurse synchronously.
      if (firing) {
        queueMicrotask(() => {
          for (const fn of listeners) {
            try {
              fn(row);
            } catch (e) {
              console.warn(
                `EventStore listener threw: ${e instanceof Error ? e.message : String(e)}`
              );
            }
          }
        });
        return row;
      }
      firing = true;
      try {
        for (const fn of listeners) {
          try {
            fn(row);
          } catch (e) {
            console.warn(
              `EventStore listener threw: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
      } finally {
        firing = false;
      }
      return row;
    },

    /**
     * Events for the given tasks, newer than `sinceTs`, most-recent-first.
     * `taskIds` is computed by the caller from the session's involvement
     * (bound tasks + agent's assigned/created tasks without a session).
     * Empty `taskIds` returns no rows.
     */
    recentForTasks(
      taskIds: string[],
      sinceTs: number,
      limit = 20
    ): TaskEventRow[] {
      if (taskIds.length === 0) return [];
      return orm
        .select()
        .from(taskEvents)
        .where(
          and(
            inArray(taskEvents.taskId, taskIds),
            gt(taskEvents.createdAt, sinceTs)
          )
        )
        .orderBy(desc(taskEvents.createdAt))
        .limit(limit)
        .all();
    },

    onEmit(listener: EventListener): () => void {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}

export type EventStore = ReturnType<typeof createEventStore>;
