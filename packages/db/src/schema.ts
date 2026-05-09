import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

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
      .default(sql`(unixepoch())`),
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
