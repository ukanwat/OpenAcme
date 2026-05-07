import Database from "better-sqlite3";
import * as path from "node:path";
import { resolveDataDir, type Config } from "@openacme/config";

/**
 * Initialize the SQLite database with all required tables.
 * Creates the database file if it doesn't exist.
 */
export function createDatabase(config: Config): Database.Database {
  const dataDir = resolveDataDir(config.dataDir);
  const dbPath = path.join(dataDir, "state.db");

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      title TEXT,
      system_prompt TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Create FTS5 virtual table for cross-session search
  // Using content-less FTS5 (external content) for space efficiency
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(
      content,
      session_id UNINDEXED,
      role UNINDEXED,
      content='messages',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS index in sync
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO fts_messages(rowid, content, session_id, role)
        VALUES (new.rowid, new.content, new.session_id, new.role);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO fts_messages(fts_messages, rowid, content, session_id, role)
        VALUES ('delete', old.rowid, old.content, old.session_id, old.role);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO fts_messages(fts_messages, rowid, content, session_id, role)
        VALUES ('delete', old.rowid, old.content, old.session_id, old.role);
      INSERT INTO fts_messages(rowid, content, session_id, role)
        VALUES (new.rowid, new.content, new.session_id, new.role);
    END;
  `);

  return db;
}
