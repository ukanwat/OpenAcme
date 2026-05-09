---
paths:
  - "packages/db/**"
---

# db

better-sqlite3 + Drizzle migrations + thin stores. Tables: `sessions`, `messages`, `user_profiles`. FTS5 virtual table `fts_messages` is self-contained, kept in sync via triggers that extract text from each message's `parts` JSON.

## `messages` is one row per UIMessage; `parts` is JSON

```
messages(id, session_id, role ("user"|"assistant"), parts (JSON), metadata (JSON, nullable), created_at)
```

`parts` is a JSON-stringified `UIMessagePart[]` from the AI SDK. Tool calls + their results live as `tool-${name}` parts inside an assistant message's parts array — there are NO separate per-step rows, NO `tool_calls` column, NO `tool_call_id`/`tool_name` columns.

- `MessageStore.append/getHistory` JSON-stringify/parse parts at the boundary; consumers see `StoredUIMessage{id, role, parts: unknown[], metadata?}`. `parts` typed as `unknown[]` so the db package stays free of an `ai` dep — agent-core casts to `UIMessage["parts"]`.
- One row per turn means tool-call ↔ tool-result pairing is **structural** (within one parts array). The orphan-pair concerns from the per-step shape are gone.

## File attachments live in URLs, not a sidecar table

There is no `message_attachments` table. FileUIParts carry `url: "/api/attachments/<sessionId>/<attId>/<filename>"`. The URL parses directly to `<dataDir>/attachments/<sessionId>/<attId>/<filename>` — no DB lookup to resolve a path.

- Cleanup: `SessionStore.delete` cascades messages via FK and `fs.rmSync(<attachmentsRoot>/<sessionId>)`. Pass `attachmentsRoot` via `createSessionStore(db, { attachmentsRoot })` to enable the FS hook.
- The pending-upload area `<attachmentsRoot>/__pending__/<pendingId>/...` is owned by the server's uploads route, not the db package.

## Drizzle is migrations-only; runtime uses drizzle-orm directly on prepared statements

`schema.ts` defines tables for drizzle-kit to generate SQL migrations. The stores in `src/stores/` use the `drizzle()` query builder for queries; a couple of hot paths (FTS search, atomic INSERT-WHERE-NOT-EXISTS) drop to raw `db.prepare` / `sql\`\`` for shape control.

- Don't introduce a separate ORM layer or repository pattern. The store is the boundary.

## FTS5 virtual table + JSON-extracting triggers

`fts_messages` is self-contained (no `content='messages'` external-content reference — the `parts` column structure doesn't match the FTS column shape). Triggers on `messages`:

- `INSERT`: extract text-parts via `json_each(NEW.parts) WHERE json_extract(value, '$.type') = 'text'`, `GROUP_CONCAT` into `content`, insert into FTS.
- `DELETE`: `DELETE FROM fts_messages WHERE rowid = OLD.rowid`.
- `UPDATE`: delete + re-insert.

Tool inputs/outputs and reasoning are intentionally NOT indexed — they'd flood search results with noisy JSON-arg matches. Search hits the user-and-assistant prose only.

- New part type that should be searchable? Extend the trigger's `WHERE` clause; bump the migration.
- `MessageStore.search()` and the `session_search` tool both depend on `fts_messages` being current.

## Message ordering: `(created_at, rowid)`, both required

`unixepoch()` is second-resolution; a tight bulk insert (e.g. compression fork copying tail messages) lands inside one second. The `rowid` tie-break is the secondary sort that keeps deterministic order.

- Drop `rowid` and bulk-inserted messages return in arbitrary order — usually masked, but real bugs surface in compression where the algorithm walks rows in insertion order.

## Cascading delete is FK-driven; do not soft-delete

`messages.session_id` has `ON DELETE CASCADE`. Session deletion fires the FTS triggers and cleans the index.

- Soft-delete (e.g., a `deleted_at` column) bypasses the triggers. FTS index lies, search returns ghost results.
- Compression forks **don't delete the parent** — they're hidden via `listActive()` (parent rows have a child). The full chain is auditable.

## Synchronous API. Don't wrap in async unless you must.

better-sqlite3 is synchronous by design. Stores expose sync methods returning the result directly.

- Don't introduce `async` on store methods to "future-proof" — adds Promise overhead and hides backpressure.
- Async is only justified if a store method does network I/O (none currently do).

## Schema change workflow

```
edit packages/db/src/schema.ts
pnpm db:generate         # drizzle-kit emits a new SQL file in drizzle/
inspect drizzle/<new>.sql
git add packages/db/src/schema.ts drizzle/
```

- Hand-editing a **committed** migration is a footgun — environments that already ran it won't pick up the change. Generate a new migration instead.
- For FTS triggers (drizzle-kit can't model virtual tables), hand-write the SQL inside the same migration or a sibling `*_fts.sql` migration and add a journal entry.

## Stores are the boundary

`SessionStore`, `MessageStore` (`src/stores/`). App code uses these — no raw `db.prepare` calls outside the package.

- UUIDs are auto-generated when `id` isn't supplied.
- `createChildIfNoSibling` (`session-store.ts`) is the only "unconventional" store method — it uses raw SQL with `INSERT ... WHERE NOT EXISTS` to make compression-fork creation race-safe.
- `AgentStore` lives in `@openacme/config`, not here. Agents are filesystem-backed YAML, not DB rows.
