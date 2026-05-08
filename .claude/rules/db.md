---
paths:
  - "packages/db/**"
---

# db

better-sqlite3 + Drizzle migrations + thin stores. Tables: `agents`, `sessions`, `messages`, `user_profiles`. FTS5 virtual table `fts_messages` is content-less, kept in sync via triggers.

## Drizzle is migrations-only; runtime is raw prepared statements

`schema.ts` defines tables for drizzle-kit to generate SQL migrations. The stores in `src/stores/` use `better-sqlite3` prepared statements directly — no drizzle ORM at runtime.

- Why: zero overhead, easier to reason about query plans, no surprise N+1 from lazy relations.
- Don't introduce drizzle ORM at runtime. If you find yourself wanting it, you probably want a hand-written prepared statement instead.

## FTS5 virtual tables live in raw migration SQL

`fts_messages` and its `INSERT`/`UPDATE`/`DELETE` triggers cannot be modeled in `schema.ts` — drizzle-kit doesn't support virtual tables. They live in dedicated `*_fts.sql` migrations.

- Changing indexed columns requires hand-editing the FTS migration (or adding a new one). Drizzle won't catch it.
- Search lives in `MessageStore.search()` and the `session_search` tool — both depend on `fts_messages` being current.

## Message ordering: `(created_at, rowid)`, both required

Compression forks copy tail messages with **identical `created_at`**. The `rowid` tie-break is what keeps tool-call → tool-result pairs adjacent in `getHistory()`.

- Drop `rowid` from the sort and history reconstruction breaks: pairs interleave, the agent-core history loader drops orphan tool-calls, model loses tool context.
- New ordering needs (e.g., updated_at sort): keep `rowid` as the secondary tie-break.

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
- New FTS column? Add a parallel `*_fts.sql` migration; drizzle-kit can't help.

## Stores are the boundary

`SessionStore`, `MessageStore`, `AgentStore` (`src/stores/`). App code uses these — no raw `db.prepare` calls outside the package.

- UUIDs are auto-generated when `id` isn't supplied.
- `createChildIfNoSibling` (`session-store.ts`) is the only "unconventional" store method — it uses raw SQL with `INSERT ... WHERE NOT EXISTS` to make compression-fork creation race-safe.
