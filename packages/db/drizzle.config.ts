import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit is the schema → migration generator. It is a build-time tool
 * only — runtime migration application happens via `drizzle-orm`'s
 * `migrate()` (see `src/connection.ts`). Run `pnpm --filter @openacme/db
 * db:generate` after editing `src/schema.ts` and commit both the schema
 * change and the generated SQL together.
 *
 * `dbCredentials.url` here is only used by drizzle-kit subcommands like
 * `db:push` / `db:studio`, not at runtime. We point it at the user's
 * default install path so `studio` can connect without extra args.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./dev.db",
  },
});
