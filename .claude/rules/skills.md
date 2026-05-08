---
paths:
  - "packages/skills/**"
---

# skills

Loader for the Anthropic Agent Skills format. Discovers `SKILL.md` files in a directory tree, parses frontmatter, ships an index into the system prompt, and serves full content on demand via a `skill_view`-style tool.

## Progressive disclosure: index up front, body on demand

`getIndex()` / `getIndexAsString()` ship name + description + tags only. That's what's injected into the system prompt — keeps the prompt cheap even with many skills installed.

- `getSkill(name)` returns the full markdown body + companion file metadata. Wired through the `skill_view` tool by `AgentManager` (`bindSkillView`).
- **Never inject full skill bodies into the system prompt.** Defeats the design and blows up the prompt cache.

## Frontmatter is dual-format

Prefer Anthropic standard (top-level `tags`, `related-skills`); fall back to legacy hermes (`metadata.hermes.tags`, `related_skills`).

- Both must keep parsing — skills exist in both shapes in the wild and we don't migrate them.
- New optional field: prefer Anthropic-standard names. If you must extend the schema, add to both formats.

## Name collision: parent directory wins as fallback

If frontmatter omits `name`, `parseSkillDirectory` uses `path.basename(parentDir)` as the fallback (`registry.ts:66`). Two skills in differently-located but same-named dirs collide — last one loaded wins, no warning.

- Operator-facing fix: require `name` in frontmatter for any skill that's not co-located with its definitive name.
- Don't try to disambiguate via path — agents reference skills by name.

## Limits & resolution

- Max file size: 1 MB (`MAX_SKILL_FILE_SIZE`, `registry.ts:8`). Larger files are skipped with a warning.
- Symlinks resolved via `fs.realpathSync` — shared org-wide skills directory linked into a project works.
- Companion files (non-`SKILL.md` files in the skill dir) are discovered at load but **not read** until `getSkill()`. Metadata only (path, size).

## Per-agent filtering

`AgentDefinitionSchema.skills` is an allowlist (or empty/missing → all skills). Filtering happens in `Agent` when assembling the index — registry doesn't pre-filter.

- Adding "deny" semantics? Reconsider — the allowlist plus "empty = all" is sufficient and avoids a third state.

## When to add a skill vs add a tool

- A **tool** is invoked by the model with structured args; ToolRegistry handles dispatch.
- A **skill** is reference content the model reads when relevant; no dispatch, no args.
- If the workflow has steps that change state, it's a tool. If it's "here's how we do X around here," it's a skill.
