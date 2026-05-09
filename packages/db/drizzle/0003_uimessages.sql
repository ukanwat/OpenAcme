-- Migrate `messages` from the legacy per-step DB shape (content +
-- tool_calls JSON + tool_call_id + tool_name) to the AI SDK UIMessage
-- shape: one row per UIMessage, parts JSON encodes everything (text,
-- tool calls + results, file attachments). Pre-1.0; existing rows are
-- dropped — no backfill — see the migration plan.
--
-- The old fts_messages was content-less with `content='messages'`
-- pointing at a `content` column we're dropping. Drop the FTS table
-- and recreate as a self-contained FTS5 (no external content backing);
-- triggers below project text from `parts` JSON into it.

DROP TABLE IF EXISTS `fts_messages`;
--> statement-breakpoint
DROP TABLE `messages`;
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_session_id` ON `messages` (`session_id`);
--> statement-breakpoint
-- Self-contained FTS5 (no external `content=` backing). Triggers below
-- project text from `parts` JSON into `content` for indexing.
CREATE VIRTUAL TABLE `fts_messages` USING fts5(
  content,
  session_id UNINDEXED,
  role UNINDEXED
);
--> statement-breakpoint
-- FTS5 triggers, written for the parts-JSON shape. `json_each` walks
-- the parts array; we GROUP_CONCAT only the text parts so search hits
-- semantic content. Tool I/O and reasoning are deliberately not indexed
-- (we don't want noisy hits on JSON arg blobs).
CREATE TRIGGER `messages_ai` AFTER INSERT ON `messages` BEGIN
  INSERT INTO fts_messages(rowid, content, session_id, role)
  SELECT new.rowid,
         COALESCE(
           (SELECT GROUP_CONCAT(json_extract(value, '$.text'), ' ')
            FROM json_each(new.parts)
            WHERE json_extract(value, '$.type') = 'text'),
           ''),
         new.session_id,
         new.role;
END;
--> statement-breakpoint
CREATE TRIGGER `messages_ad` AFTER DELETE ON `messages` BEGIN
  -- Self-contained FTS deletes by rowid; no need to reproduce content.
  DELETE FROM fts_messages WHERE rowid = old.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER `messages_au` AFTER UPDATE ON `messages` BEGIN
  DELETE FROM fts_messages WHERE rowid = old.rowid;
  INSERT INTO fts_messages(rowid, content, session_id, role)
  SELECT new.rowid,
         COALESCE(
           (SELECT GROUP_CONCAT(json_extract(value, '$.text'), ' ')
            FROM json_each(new.parts)
            WHERE json_extract(value, '$.type') = 'text'),
           ''),
         new.session_id,
         new.role;
END;
