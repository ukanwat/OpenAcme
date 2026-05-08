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
    // Stored / returned as integer 0|1. We considered mode: "boolean" to
    // skip the hand-rolled hydrate, but drizzle-kit treats the changed
    // default literal (`0` → `false`) as a schema diff and emits a full
    // table-rebuild migration. Not worth it for one boolean cast.
    compressionPending: integer("compression_pending").notNull().default(0),
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

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // enum narrows the inferred TS type (`"system" | "user" | "assistant"
    // | "tool"`) without changing the SQL — no CHECK constraint emitted.
    role: text("role", {
      enum: ["system", "user", "assistant", "tool"],
    }).notNull(),
    content: text("content"),
    toolCalls: text("tool_calls"),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
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
// optional, the rest stay required).
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;
