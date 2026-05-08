# @openacme/server

## 0.2.0

### Minor Changes

- Anthropic Agent Skills standard + agent-loadable skill bodies.
  - `@openacme/skills` parses canonical top-level frontmatter (`tags`, `related-skills`) while still reading legacy `metadata.hermes.*`. Skill folders are walked at load time so companion files (`scripts/*`, `references/*`, …) are recorded as resources without being read until requested. New `parseSkillDirectory` + `Skill.resources`/`Skill.dirPath`.
  - `@openacme/tools` ships a new `skill_view` built-in (Level 1 progressive disclosure) bound from the server. Returns the SKILL.md body, the on-disk dir path, and the resource list — agents read companion files via the existing `read_file` / `shell` tools.
  - `@openacme/server` exposes `POST /api/skills/import` for multipart folder uploads (path-traversal guards, 200-entry / 10 MB cap, top-prefix stripping) and binds the skill registry into `skill_view`.
  - `@openacme/cli` adds `openacme skills list|view|add|remove` and a `/skills` slash command + read-only overlay in the TUI.
  - `@openacme/agent-core` system prompt now points the model at `skill_view`.
  - `@openacme/config` adds `skill_view` to the default agent tools array.

  All `@openacme/*` packages bump together (changeset `fixed` group) so users always get a uniform version across the workspace.

### Patch Changes

- Updated dependencies []:
  - @openacme/skills@0.2.0
  - @openacme/tools@0.2.0
  - @openacme/agent-core@0.2.0
  - @openacme/config@0.2.0
  - @openacme/mcp-client@0.2.0
  - @openacme/db@0.2.0
  - @openacme/llm-provider@0.2.0
  - @openacme/auth@0.2.0
