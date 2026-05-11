/**
 * Structural ports for external stores TaskStore depends on.
 * Defined here (not imported from @openacme/db) so the tasks package
 * stays free of a runtime dep on the DB. AgentManager wires the
 * concrete DB-backed stores in; tests can pass mocks or omit them.
 *
 * **All "kind" unions for the task subsystem live here** — `CommentKind`
 * for comments, `EventKind` for events. Magic strings elsewhere should
 * narrow to one of these. Add new kinds at this central spot and the
 * tools / routes / web mirrors will surface type errors at every site
 * that needs updating.
 */

/**
 * Canonical comment kinds. `null` (or undefined) = generic, untagged.
 * Add new kinds HERE — every other place that types kinds (DB schema's
 * drizzle enum hint, DB store types, web mirror) imports from here so
 * the type checker surfaces every reader site that needs an update.
 */
export const COMMENT_KINDS = ["result", "system"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export interface Comment {
  id: string;
  taskId: string;
  author: string;
  kind: CommentKind | null;
  body: string;
  createdAt: number;
}

export interface CommentInput {
  taskId: string;
  author: string;
  body: string;
  kind?: CommentKind | null;
}

export interface CommentListOptions {
  limit?: number;
  sinceTs?: number;
  /** Inclusive kind filter. Pass `null` in the array to also include
   *  untagged (default-kind) comments alongside the named kinds. */
  kinds?: (CommentKind | null)[];
}

export interface CommentStorePort {
  add(input: CommentInput): Comment;
  list(taskId: string, opts?: CommentListOptions): Comment[];
  latestResult(taskId: string): Comment | null;
  countByTask(taskIds: string[]): Map<string, number>;
  deleteByTask(taskId: string): void;
}

/**
 * Canonical event kinds (single source of truth — see COMMENT_KINDS
 * note above). Adding a new kind: extend the list here, then a single
 * recompile narrows every reader (DB schema, store, prompt rendering,
 * web activity log).
 */
export const EVENT_KINDS = [
  "task_assigned",
  "status_changed",
  "dep_unblocked",
  "comment_added",
  "task_deleted",
  "scheduler_action",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventInput {
  taskId: string;
  /** Semantic owner of the event (usually the assignee). Used for the
   *  prompt's "actor X" rendering when no explicit actor is recorded. */
  agentId: string;
  /** Optional: the agent that *caused* this event. When set, the
   *  scheduler suppresses wake for that agent's own session (echo).
   *  When unset, no echo suppression applies — events from anonymous
   *  / system / unknown actors always wake. */
  actor?: string | null;
  kind: EventKind;
  payload?: unknown;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  agentId: string;
  /** The actor that caused this event, if recorded. Null/undefined for
   *  anonymous / system events that should never be echo-suppressed. */
  actor?: string | null;
  kind: string;
  payload: string | null;
  createdAt: number;
}

export interface EventStorePort {
  append(input: EventInput): unknown;
  recentForTasks(taskIds: string[], sinceTs: number, limit?: number): TaskEvent[];
}
