import Database from "better-sqlite3";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolveDataDir, type Config } from "@openacme/config";

/**
 * Open the SQLite database for OpenAcme and apply any pending migrations.
 *
 * Schema is owned by drizzle: edit `src/schema.ts`, run `pnpm db:generate`
 * to produce a new migration in `drizzle/`, commit both. At runtime
 * `drizzle-orm`'s migrator applies anything not yet recorded in
 * `__drizzle_migrations`. Never write `ALTER TABLE` by hand — let
 * drizzle-kit generate it from a schema diff.
 *
 * The package itself remains backed by raw better-sqlite3 prepared
 * statements (see `stores/`). Drizzle is used for migrations only; the
 * stores stay zero-overhead.
 */
export function createDatabase(config: Config): Database.Database {
  const dataDir = resolveDataDir(config.dataDir);
  const dbPath = path.join(dataDir, "state.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

/**
 * Apply all migrations to a database. Used by `createDatabase` and by
 * tests to bootstrap an in-memory db.
 */
export function applySchema(db: Database.Database): void {
  migrate(drizzle(db), { migrationsFolder: MIGRATIONS_FOLDER });
}

// Resolve the migrations folder relative to this module. Works in both
// development (TS source under `src/`) and after build (JS under `dist/`)
// since `drizzle/` is a sibling of both.
const MIGRATIONS_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle"
);
