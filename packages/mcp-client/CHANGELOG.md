# @openacme/mcp-client

## 0.5.2

### Patch Changes

- Updated dependencies []:
  - @openacme/tools@0.5.2
  - @openacme/config@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @openacme/tools@0.5.1
  - @openacme/config@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.5.0
  - @openacme/tools@0.5.0

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

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.4.0
  - @openacme/tools@0.4.0

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
  - @openacme/tools@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @openacme/tools@0.2.0
  - @openacme/config@0.2.0
