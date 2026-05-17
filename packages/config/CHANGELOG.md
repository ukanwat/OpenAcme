# @openacme/config

## 0.5.3

## 0.5.2

## 0.5.1

## 0.5.0

### Minor Changes

- Add `cacheTtl: "5m" | "1h"` to model config so callers can opt into Anthropic's 1-hour prompt-cache tier. Threaded into both Anthropic-cache code paths (native Anthropic via `applyAnthropicCacheControl(messages, ttl)` and OpenRouter+Claude via `injectAnthropicCacheControl(body, ttl)`). Per-agent UI in the agents page; workforce-wide default in Settings → Providers backed by new `GET /api/config` (extended) + `PUT /api/config/model`.

## 0.4.0

### Minor Changes

- Release 0.4.0.

  Highlights since 0.3.0:
  - **Browser tool**: managed Chrome via CDP with shared user-data-dir and per-agent tab ownership; ten `browser_*` tools.
  - **Tasks v2**: comments + events split out of the task body into SQLite; pure event-driven scheduler with debounced wakes, echo suppression, lazy session allocation, recurring self-reset, and mid-turn event injection.
  - **Agent catalog**: bespoke in-tree templates importable into the workforce (CLI `agents catalog` / `agents import`, web modal). Ships the Coder and Acme platform templates.
  - **Skills Hub**: install + track skills from GitHub, marketplaces, URLs, `.well-known`, LobeHub, Skills.sh, ClawHub, local dirs, and a new `builtin` source.
  - **AGENTS.md**: shared workforce context injected into every agent's prompt; restart-free updates via cache eviction.
  - **Per-agent workspace + resources**: `<agentDir>/workspace/` as default cwd with a session-persistent shell, and `<agentDir>/resources/` listed in the prompt.
  - **First-run setup wizard**: provider credentials, model seed, agent creation — web + CLI.
  - **SSE-only streaming** for interactive turns: agent runs are server-owned, the originating tab is just another subscriber.
  - **Pino-backed structured logger** with OTel log export.
  - **LLM-generated session titles** via a structured subagent.
  - **Operator home page** with live SSE, plus `ping_user` / `sleep` primitives.
  - **Workforce framing**: `role` + `agent_list` tool + peer-notes memory; silent OAuth recovery via Claude Code re-import.
  - **Design refresh**: four-color signal system, unified task activity timeline, polished OAuth callback, CLI per-tool rendering with green/red diff backgrounds.

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

## 0.2.0

### Patch Changes

- Anthropic Agent Skills standard + agent-loadable skill bodies.
  - `@openacme/skills` parses canonical top-level frontmatter (`tags`, `related-skills`) while still reading legacy `metadata.hermes.*`. Skill folders are walked at load time so companion files (`scripts/*`, `references/*`, …) are recorded as resources without being read until requested. New `parseSkillDirectory` + `Skill.resources`/`Skill.dirPath`.
  - `@openacme/tools` ships a new `skill_view` built-in (Level 1 progressive disclosure) bound from the server. Returns the SKILL.md body, the on-disk dir path, and the resource list — agents read companion files via the existing `read_file` / `shell` tools.
  - `@openacme/server` exposes `POST /api/skills/import` for multipart folder uploads (path-traversal guards, 200-entry / 10 MB cap, top-prefix stripping) and binds the skill registry into `skill_view`.
  - `@openacme/cli` adds `openacme skills list|view|add|remove` and a `/skills` slash command + read-only overlay in the TUI.
  - `@openacme/agent-core` system prompt now points the model at `skill_view`.
  - `@openacme/config` adds `skill_view` to the default agent tools array.

  All `@openacme/*` packages bump together (changeset `fixed` group) so users always get a uniform version across the workspace.
