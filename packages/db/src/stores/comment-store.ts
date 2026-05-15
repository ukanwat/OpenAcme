import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { taskComments, type TaskCommentRow } from "../schema.js";

export type { TaskCommentRow } from "../schema.js";

// Single source of truth for `CommentKind` is `@openacme/tasks/ports`.
import type { CommentKind } from "@openacme/tasks";

export interface CommentInput {
  taskId: string;
  author: string;
  body: string;
  kind?: CommentKind | null;
  id?: string;
}

export interface CommentListOptions {
  limit?: number;
  sinceTs?: number;
  /** Inclusive kind filter. Pass `null` in the array to include untagged. */
  kinds?: (CommentKind | null)[];
}

/**
 * Append-only thread of task discussion. One row per comment.
 * Reserved kinds: "result" (assignee's canonical answer), "system"
 * (scheduler / automation). Authorship gates live in the tool layer;
 * the store accepts whatever it's given.
 */
export function createCommentStore(db: Database.Database) {
  const orm = drizzle(db);

  return {
    add(input: CommentInput): TaskCommentRow {
      return orm
        .insert(taskComments)
        .values({
          id: input.id ?? randomUUID(),
          taskId: input.taskId,
          author: input.author,
          kind: input.kind ?? null,
          body: input.body,
        })
        .returning()
        .get();
    },

    get(id: string): TaskCommentRow | null {
      return (
        orm.select().from(taskComments).where(eq(taskComments.id, id)).get() ??
        null
      );
    },

    /** Oldest-first. `kinds` is an inclusive filter; pass null in the
     *  array to also include untagged (default-kind) comments. */
    list(taskId: string, opts: CommentListOptions = {}): TaskCommentRow[] {
      const filters = [eq(taskComments.taskId, taskId)];
      if (opts.sinceTs !== undefined) {
        filters.push(gt(taskComments.createdAt, opts.sinceTs));
      }
      if (opts.kinds && opts.kinds.length > 0) {
        const namedKinds = opts.kinds.filter(
          (k): k is CommentKind => k !== null
        );
        const wantsNull = opts.kinds.length > namedKinds.length;
        const kindClause =
          wantsNull && namedKinds.length > 0
            ? or(isNull(taskComments.kind), inArray(taskComments.kind, namedKinds))
            : wantsNull
              ? isNull(taskComments.kind)
              : inArray(taskComments.kind, namedKinds);
        if (kindClause) filters.push(kindClause);
      }
      const q = orm
        .select()
        .from(taskComments)
        .where(and(...filters))
        .orderBy(asc(taskComments.createdAt));
      return opts.limit !== undefined ? q.limit(opts.limit).all() : q.all();
    },

    /** Most recent `kind: "result"` comment, or null. */
    latestResult(taskId: string): TaskCommentRow | null {
      return (
        orm
          .select()
          .from(taskComments)
          .where(
            and(eq(taskComments.taskId, taskId), eq(taskComments.kind, "result"))
          )
          .orderBy(desc(taskComments.createdAt))
          .limit(1)
          .get() ?? null
      );
    },

    countByTask(taskIds: string[]): Map<string, number> {
      if (taskIds.length === 0) return new Map();
      const rows = orm
        .select({
          taskId: taskComments.taskId,
          count: sql<number>`count(*)`,
        })
        .from(taskComments)
        .where(inArray(taskComments.taskId, taskIds))
        .groupBy(taskComments.taskId)
        .all();
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.taskId, Number(r.count));
      return counts;
    },

    deleteByTask(taskId: string): void {
      orm.delete(taskComments).where(eq(taskComments.taskId, taskId)).run();
    },
  };
}

export type CommentStore = ReturnType<typeof createCommentStore>;
