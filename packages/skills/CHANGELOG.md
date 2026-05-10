# @openacme/skills

## 0.3.0

### Minor Changes

- Per-agent state (memory + tasks), AI SDK v6 migration, MCP HTTP + OAuth, prompt caching, attachments, and a paper-aesthetic web UI.
  - **Per-agent persistent memory** (`@openacme/memory`) and **per-agent task store + scheduler** (`@openacme/tasks`) — both filesystem-backed, scoped by agent id. New `task_*` and `memory` built-in tools.
  - **AI SDK v4 → v6 migration** end-to-end. `UIMessage` is now the canonical shape across DB rows, persistence, agent input, server response, and web render. Web uses `@ai-sdk/react`'s `useChat` + `DefaultChatTransport`; server uses `createUIMessageStream` over `Agent.runStream`. Zod 3 → 4.
  - **Anthropic prompt caching** for native and OpenRouter Claude paths; cache markers preserve string content as string when marking cacheable.
  - **MCP**: first-class Streamable HTTP transport with OAuth 2.1 client, plus `cwd` for stdio servers. Web + CLI editors for per-agent MCP server config.
  - **Web UI**: paper-aesthetic redesign, theme toggle (system/light/dark) with light-mode contrast pass, single-URL dev (Hono fronts UI on `:3210` via proxy to Next; published serves the bundled static export from the same port), proper date-time picker and searchable assignee in the task modal, inline custom views and git-style diffs in tool rendering, attachments via picker / drag-drop / `@`-fuzzy file picker.
  - **CLI**: cancellable turns, credential-aware model pickers, windowed session picker that surfaces agent name, background daemon mode with secret-auth for non-loopback access, consolidated `pnpm agent <subcommand>` aliases.
  - **Server**: RFC 5987 Content-Disposition for non-ASCII attachment filenames; `/api/health` now reports the actual server package version instead of a hardcoded string. Always-on system tools (agent introspection / self-management) merged into every agent's effective tool set and hidden from the user-facing tool picker.

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.3.0

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
  - @openacme/config@0.2.0
