---
paths:
  - "packages/config/**"
---

# config

Zod schemas + YAML loader + agent-store. The schema (`schema.ts`) is the single source of truth; everything else reads through `loadConfig()` or the agent store.

## `ConfigSchema` is the in-memory shape, not the on-disk shape

`config.yaml` on disk is **partial** — users only write what they want to override. `loadConfig(dataDirOverride?)` reads the YAML, merges with Zod `.default()` values, and returns the fully-populated runtime object.

- Always go through `loadConfig()`. Reading `config.yaml` directly elsewhere bypasses defaults and ships missing fields as `undefined`.
- `loadConfig` also loads `<dataDir>/.env` so `OPENACME_DEBUG`, telemetry tokens, etc. are present before any provider factory runs.

## Config writers must merge, not overwrite

`ConfigSchema.parse` materializes every default. If a config writer parses, mutates, then `saveConfig()`, **all those defaults get written to disk** — overwriting the user's blank fields with our defaults, and locking them out from future default changes.

- Use `readRawConfig` + `writeRawConfig` for any writer (setup wizard, migration tool, edit-config UI).
- The setup wizard has been burned by this. The pattern matters.

## Agents do **not** live in the database

Each agent is `<dataDir>/agents/<id>/AGENT.md` — YAML frontmatter + optional system-prompt body. `createAgentStore()` reads/writes those files; no caching, changes visible immediately.

- Why: agents are user-editable artifacts; SQLite storage would force a UI flow for things like "edit my system prompt in vim."
- New agent fields go in `AgentDefinitionSchema` first. The store reads/writes whatever the schema declares.

## `AgentDefinitionSchema` defaults are extensive — change them here first

Tool list, persona, server settings, behavior knobs (`maxSteps: 10`, `maxIterations: 90`), skills config — all default via Zod. Most "default agent behavior" is one schema edit away.

- Adding a new code branch for a default? Stop. Change the schema default first; if the code doesn't read it through the schema, fix that.
- New tool that should ship by default: add it to `AgentDefinitionSchema.tools.default([...])`.

## `data/model-registry.json` is build-time bundled

Snapshot of `https://models.dev/api.json`, consulted by `lookupModelMetadata()` in `@openacme/llm-provider`.

- Offline builds miss models added to models.dev after the snapshot.
- `custom` and `ollama` are intentionally not in the registry — `lookupModelMetadata` returns undefined for them and compression falls back to reactive 413 recovery.

## Adding a config field

1. Add to the relevant Zod schema with a `.default(...)`.
2. Read it via `loadConfig()` everywhere — never `process.env.X` or raw YAML.
3. If user-facing, add a setup-wizard prompt (write via `readRawConfig` + `writeRawConfig`).
