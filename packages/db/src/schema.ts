import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import {
  COMMENT_KINDS,
  EVENT_KINDS,
  INBOX_KINDS,
  INBOX_SOURCES,
} from "@openacme/tasks";

/**
 * Drizzle schema definitions. Source of truth for the structured tables;
 * `drizzle-kit generate` reads this file to produce SQL migrations under
 * `packages/db/drizzle/`. Never write `ALTER TABLE` by hand — change the
 * schema here, regenerate, and a new migration appears.
 *
 * FTS5 virtual tables and their sync triggers are NOT modeled here
 * (drizzle-kit doesn't know about them). They live in the dedicated
 * `*_fts.sql` migration alongside the auto-generated ones.
 *
 * Note on `agent_id`: agents themselves live as YAML files under
 * `<dataDir>/agents/<id>/AGENT.md` — the field here is just a label, no
 * foreign key to a `agents` table.
 */

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    title: text("title"),
    systemPrompt: text("system_prompt"),
    parentSessionId: text("parent_session_id"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => sql`(unixepoch())`),
    // One-shot "skip routine spawns until this time" set by the agent
    // via `defer_session(duration)`. Cleared when the dispatcher next
    // spawns the session (defer is one-shot, not sticky). New inbox
    // rows bypass the defer — it suppresses routine checks only, not
    // real signals. Capped at now + 24h at write time.
    deferUntil: integer("defer_until"),
  },
  (t) => [
    index("idx_sessions_agent_id").on(t.agentId),
    index("idx_sessions_parent").on(t.parentSessionId),
  ]
);

/**
 * One row per UIMessage. `parts` is `UIMessagePart[]` from the AI SDK,
 * stored as JSON. Tool calls + their results live as `tool-${name}`
 * parts inside the same assistant message — no per-step rows. File
 * attachments are `file` parts whose `url` is `/api/attachments/<...>`,
 * pointing at bytes on disk under `<dataDir>/attachments/<sessionId>/`.
 *
 * `content` / `tool_calls` / `tool_call_id` / `tool_name` columns are
 * gone. The pre-UIMessage shape is dropped, no backfill — see plan.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    parts: text("parts").notNull(),
    metadata: text("metadata"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("idx_messages_session_id").on(t.sessionId)]
);

export const userProfiles = sqliteTable("user_profiles", {
  id: text("id").primaryKey(),
  content: text("content").notNull().default(""),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Task-anchored discussion thread. One row per comment. Append-only —
 * no edit, no delete; mistakes get follow-up comments. `task_id` has no
 * FK constraint because tasks live as filesystem markdown, not DB rows.
 *
 * `kind` is nullable for plain comments. Reserved values: "result"
 * (assignee's canonical answer at completion) and "system" (scheduler /
 * automation-authored annotations). Tool surface gates writes.
 */
export const taskComments = sqliteTable(
  "task_comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    author: text("author").notNull(),
    /** Drizzle `enum` is a TS hint only (no DB CHECK constraint).
     *  Single source of truth: `COMMENT_KINDS` in `@openacme/tasks`. */
    kind: text("kind", { enum: COMMENT_KINDS }),
    body: text("body").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("idx_task_comments_task").on(t.taskId, t.createdAt),
    index("idx_task_comments_kind").on(t.taskId, t.kind),
  ]
);

/**
 * Append-only event log. Originally task-anchored; now polymorphic
 * across task events and session-level events (e.g. `ping_user` where
 * no task is in scope). Constraint: at least one of (task_id, session_id)
 * is set — enforced at write time in `EventStore.append`. Both indices
 * exist so reads from either anchor are cheap.
 *
 * `agent_id` is the actor (or "system:scheduler"); the recipient is
 * computed implicitly at read time from task involvement / session
 * binding.
 */
export const taskEvents = sqliteTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id"),
    sessionId: text("session_id"),
    agentId: text("agent_id").notNull(),
    /** The actor that caused this event (agent id). Used both for
     *  prompt attribution and for the wake policy's echo suppression
     *  — a session never wakes from its owning agent's own actions.
     *  Null = anonymous / auto / system, which always wakes. */
    actor: text("actor"),
    /** Drizzle `enum` is a TS hint only. Single source of truth:
     *  `EVENT_KINDS` in `@openacme/tasks`. */
    kind: text("kind", { enum: EVENT_KINDS }).notNull(),
    payload: text("payload"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("idx_task_events_task").on(t.taskId, t.createdAt),
    index("idx_task_events_session").on(t.sessionId, t.createdAt),
    index("idx_task_events_created").on(t.createdAt),
  ]
);

/**
 * Per-agent delivery queue. Rows are written when signals (user
 * messages, task events, system notices) should reach an agent that
 * isn't currently reading. The runtime drains pending rows at turn
 * start and at LLM-step boundaries, then **hard-deletes** them — this
 * table is staging, not audit. The immutable audit log lives in
 * `task_events`.
 *
 * Ordering is by `id` (autoincrement). Same-agent self-emits are
 * filtered at the delivery boundary (in AgentManager) so the agent's
 * own actions don't show up in its own inbox.
 */
export const agentInbox = sqliteTable(
  "agent_inbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull(),
    /** Drizzle `enum` is a TS hint only. Source of truth:
     *  `INBOX_KINDS` in `@openacme/tasks`. */
    kind: text("kind", { enum: INBOX_KINDS }).notNull(),
    /** Two values: `"user"` for anything originating from a human,
     *  `"system"` for everything platform-generated (task events,
     *  cron, system notices). Source of truth: `INBOX_SOURCES`. */
    source: text("source", { enum: INBOX_SOURCES }).notNull(),
    /** Optional originator id — user id for `source: "user"`, agent id
     *  or system tag for `source: "system"`. Not used for routing;
     *  surfaced in the rendered drain for audit / prompt context. */
    sourceId: text("source_id"),
    relatedTask: text("related_task"),
    relatedSession: text("related_session"),
    /** JSON. For `user_message`, the full UIMessage so it can be
     *  spliced into the chat history at drain time. For
     *  `system_notice`, a small structured object the renderer
     *  formats as text. */
    payload: text("payload").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("idx_inbox_agent").on(t.agentId, t.id)]
);

// Schema-derived types. `$inferSelect` is what comes out of a query;
// `$inferInsert` is what callers pass in (defaults / nullables become
// optional, the rest stay required). The `parts` column is JSON-stringified
// `UIMessagePart[]` — the store layer parses on read, stringifies on write.
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;
export type TaskCommentRow = typeof taskComments.$inferSelect;
export type NewTaskCommentRow = typeof taskComments.$inferInsert;
export type TaskEventRow = typeof taskEvents.$inferSelect;
export type NewTaskEventRow = typeof taskEvents.$inferInsert;
export type AgentInboxRow = typeof agentInbox.$inferSelect;
export type NewAgentInboxRow = typeof agentInbox.$inferInsert;
