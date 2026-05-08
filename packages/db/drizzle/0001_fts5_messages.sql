-- FTS5 mirror of messages.content for cross-session full-text search
-- (used by the `session_search` tool). drizzle-kit can't model virtual
-- tables, so this lives as a custom migration alongside the generated ones.

CREATE VIRTUAL TABLE `fts_messages` USING fts5(
  content,
  session_id UNINDEXED,
  role UNINDEXED,
  content='messages',
  content_rowid='rowid'
);
--> statement-breakpoint
CREATE TRIGGER `messages_ai` AFTER INSERT ON `messages` BEGIN
  INSERT INTO fts_messages(rowid, content, session_id, role)
    VALUES (new.rowid, new.content, new.session_id, new.role);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_ad` AFTER DELETE ON `messages` BEGIN
  INSERT INTO fts_messages(fts_messages, rowid, content, session_id, role)
    VALUES ('delete', old.rowid, old.content, old.session_id, old.role);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_au` AFTER UPDATE ON `messages` BEGIN
  INSERT INTO fts_messages(fts_messages, rowid, content, session_id, role)
    VALUES ('delete', old.rowid, old.content, old.session_id, old.role);
  INSERT INTO fts_messages(rowid, content, session_id, role)
    VALUES (new.rowid, new.content, new.session_id, new.role);
END;
