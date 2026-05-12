<div align="center">

# ◢◤ OpenAcme

**A workforce of AI agents.**
Different agents for different jobs. They work on their own clocks, pass tasks between each other, and post results for you to catch up on later.

<sub>Pre-1.0 · evolving fast — expect breaking changes.</sub>

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-f69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Turborepo](https://img.shields.io/badge/Turborepo-monorepo-ef4444)](https://turborepo.com/)
[![License](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)

</div>

---

## ✦ What this is

Staff it the way you'd staff a small team — one agent doing research, another watching the infra, another reviewing pull requests, another summarizing your inbox. Each runs on its own model with its own tools, skills, and memory. They run on their own clocks. They hand work between each other.

You write the briefs. They do the work. You read the summary when you check in.

### What's wired

- Multiple agent definitions — per-agent model / tools / skills / MCP / system prompt / memory / workspace / resources.
- Each agent has a public **`role`** (third-person paragraph other agents read) on top of its private **`persona`** (its own system prompt). Coworkers look each other up via `agent_list`.
- Per-agent chat in both web and TUI, backed by the same Hono server.
- Local SQLite + FTS5 history; no cloud round-trip.
- ChatGPT / Claude OAuth so subscribers don't double-pay.
- MCP tools, skills, file attachments.
- Per-agent workspace — `~/.openacme/agents/<id>/workspace/` is the default cwd; shell state (`cd`, env vars, functions) persists across calls within a session.
- Per-agent resources — drop files into `~/.openacme/agents/<id>/resources/` and they appear in the agent's prompt with absolute paths.
- Shared workforce context — `~/.openacme/AGENTS.md` is merged into every agent's prompt (editable in Settings → Context).
- Per-agent persistent memory — Anthropic memory_20250818 substrate, Claude Code MEMORY.md + per-topic-file convention.
- Managed Chrome (`@openacme/browser`) — one Chrome process per install, shared user-data-dir (so a human-side login is inherited by every agent), per-agent tab ownership.
- Skills Hub — install + track skills from GitHub, marketplaces, well-known sources, raw URLs, and local directories with lockfile + audit log + atomic swap.
- Daemon (launchd / systemd-user) with auto-start and auto-restart.
- Remote founder access via `--expose` + secret cookie.
- Autonomous wake-ups — the task scheduler runs `start_at` and recurring tasks (cron + interval) without a user in the loop.
- Scheduled jobs — `task_create` accepts `start_at` (one-shot) and `recurrence` (cron / interval); deps + auto-blocked/unblocked transitions.
- Cross-agent assignment — any agent can `task_create({assignee: other})` and the scheduler picks it up under the assignee's queue.
- Task comments + events — discussion and the signal log live in SQLite, not in the task body.

---

## ✦ What's solid today

- 🔌 **Six model providers** — Anthropic / OpenAI / Google / OpenRouter / Ollama / any OpenAI-compatible endpoint. Pick per agent.
- 🔑 **Subscription-aware auth.** OAuth into ChatGPT (Plus/Pro) or Claude (Pro/Max); API keys remain a fallback. Don't pay your provider twice.
- 🛠 **Tools that compose.** Built-in shell + filesystem + browser + session search; add any MCP server and its tools register automatically.
- 🌐 **Managed Chrome.** Headed by default with a shared user-data-dir — log into accounts once, every agent inherits the session. Per-agent tab ownership so they don't trample each other.
- 💾 **Local-only state.** SQLite + FTS5 in `~/.openacme/`. No cloud, no telemetry.
- 🧠 **Skills as progressive context.** `SKILL.md` files indexed as tags; the body is fetched on demand. Skills Hub installs and tracks them from GitHub, marketplaces, and URLs.
- 📒 **Per-agent memory.** Anthropic memory_20250818 substrate with a Claude Code-style MEMORY.md index + per-topic files.
- 🖥 **Two interfaces, one runtime.** React-on-Ink TUI and a Next.js web UI, both backed by the same Hono server.
- 🔄 **Always-on daemon.** launchd (macOS) or systemd-user (Linux); survives reboots and crashes.

---

## ⚡ Quickstart

```sh
git clone git@github.com:ukanwat/OpenAcme.git
cd OpenAcme
pnpm install              # pnpm 9 · Node ≥ 18
pnpm build
pnpm agent setup          # interactive wizard → ~/.openacme/config.yaml
pnpm agent                # starts background daemon + opens the web UI
```

The daemon registers itself with launchd (macOS) or systemd-user (Linux) on first run. It auto-starts at login and auto-restarts on crash. Subsequent `openacme start` calls are idempotent.

Or skip the browser and chat in the terminal:

```sh
pnpm agent chat           # in-process terminal chat (no server needed)
```

### Sign in with a subscription

```sh
pnpm agent login --provider anthropic    # Claude Pro / Max
pnpm agent login --provider openai       # ChatGPT Plus / Pro
```

Tokens land in `~/.openacme/auth.json` (mode `0600`) and auto-refresh.

---

## 🔄 Daemon commands

`openacme start` (the default subcommand) runs in the background via the OS service manager. All lifecycle commands are idempotent.

```sh
openacme               # same as `openacme start`
openacme start         # install unit (once) + start daemon; idempotent
openacme stop          # stop daemon (unit stays installed; won't auto-restart)
openacme restart       # stop + start
openacme status        # pid, bind address, uptime, health, recent log
openacme logs          # print the log (last 200 lines)
openacme logs -f       # follow the log live (Ctrl-C to quit)
```

### Platform support

| Platform | Service manager | Auto-start at login | Auto-restart on crash |
|---|---|---|---|
| macOS | launchd (`~/Library/LaunchAgents/`) | yes | yes |
| Linux (systemd) | systemd-user (`~/.config/systemd/user/`) | yes (see note) | yes |
| Linux (no systemd) / containers | PID file, detached spawn | no | no |

**Linux headless note:** for the daemon to run without an active login session (e.g. a server), enable user lingering once:
```sh
loginctl enable-linger $USER
```

**No systemd / Alpine:** pass `--no-service` to fall back to a PID-file managed process. No auto-restart; you are responsible for relaunching after reboots.
```sh
openacme start --no-service
openacme stop  --no-service
```

### Setup is required

`openacme start` refuses to launch until at least one agent is configured:
```
No agents configured.
Run `openacme setup` to configure your first agent.
```

---

## 🌍 Remote access

By default OpenAcme binds to `127.0.0.1` — only accessible from the machine it runs on. To reach it from other devices (phone, tablet, second laptop) pass `--expose` to start:

```sh
openacme start --expose
# or via pnpm:
pnpm agent start --expose
```

This does three things atomically:

1. Sets `server.host = 0.0.0.0` in `~/.openacme/config.yaml`
2. Generates a 64-character hex secret at `~/.openacme/secret` (mode `0600`) if one doesn't exist
3. Starts (or restarts) the daemon to apply the new bind

The secret is printed on screen:

```
  Share this secret with devices that need access:

      9c4f8a2e0d3b71856fcae9a40b8c2d7e...

  Reprint:  openacme secret
  Rotate:   openacme secret rotate
  Tunnel:   ngrok http 3210   (paste the secret on first device load)
```

### How authentication works

| Request origin | Auth required |
|---|---|
| `localhost` / `127.0.0.1` / `::1` | No — loopback always bypasses |
| LAN (`192.168.x.x:3210`) | Yes — secret required |
| ngrok / Cloudflare tunnel | Yes — tunnel preserves the non-loopback Host header |
| SSH local forward (`-L 3210:localhost:3210`) | No — Host header stays `localhost` |

The bypass is keyed on the HTTP `Host` header, not the connection IP. This means tunnels that forward to `127.0.0.1` still require the secret — the user-facing hostname in `Host` is what matters.

**Browser login:** open the web UI from a non-loopback address and you'll be redirected to `/login`. Paste the secret once; a 90-day HttpOnly cookie handles subsequent visits.

**Bearer token:** for scripts and API clients, pass the secret as a header:
```sh
curl -H "Authorization: Bearer <your-secret>" http://<host>:3210/api/health
```

### Secret management

```sh
openacme secret           # print the current secret
openacme secret rotate    # generate a new secret (invalidates all browser sessions)
```

Rotation automatically restarts the daemon so the new secret takes effect immediately.

### Revert to loopback-only

Edit `~/.openacme/config.yaml`, set `server.host: 127.0.0.1`, then run `openacme restart`.

---

## 🧭 Architecture

<div align="center">

```
   ╭─────────────────────────╮         ╭─────────────────────────╮
   │   apps/cli  ·  Ink TUI  │         │   apps/web  ·  Next.js  │
   │   in-process Agent      │         │   POST /api/chat → SSE  │
   ╰────────────┬────────────╯         ╰────────────┬────────────╯
                │                                   │ HTTP
                │                ╭──────────────────┴──────────────────╮
                │                │   @openacme/server (Hono)           │
                │                │   AgentManager · SSE streaming      │
                │                │   auth middleware (Host-header)     │
                │                ╰──┬───────────────┬───────────────┬──╯
                │                   │               │               │
        ╭───────┴────────╮  ╭──────────────╮  ╭──────────────╮  ╭──────────────────╮
        │  agent-core    │  │   tools      │  │  mcp-client  │  │  llm-provider    │
        │  Agent.chat()  │  │  registry +  │  │  stdio/SSE   │  │  6 providers +   │
        │  streamText()  │  │  built-ins   │  │  → registry  │  │  OAuth fetch     │
        ╰────────┬───────╯  ╰──────────────╯  ╰──────────────╯  ╰──────────────────╯
                 │
        ╭────────┴───────╮  ╭──────────────╮  ╭──────────────╮  ╭──────────────────╮
        │      db        │  │    config    │  │    auth      │  │     skills       │
        │  Drizzle +     │  │   Zod YAML   │  │  OAuth +     │  │   SKILL.md +     │
        │  SQLite + FTS5 │  │   loader     │  │  token store │  │   progressive    │
        ╰────────────────╯  ╰──────────────╯  ╰──────────────╯  ╰──────────────────╯
```

</div>

For navigation density — request path, file:line refs, registry shapes, gotchas — see **[`CLAUDE.md`](./CLAUDE.md)**.

---

## ⚙ Configuration

`~/.openacme/config.yaml` (YAML or JSON, validated by Zod):

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-20250514
  auth: oauth                 # or api_key

server:
  port: 3210
  host: 127.0.0.1             # loopback only by default; `openacme expose` flips to 0.0.0.0

behavior:
  maxSteps: 1000                  # safety cap on agentic steps per turn
  compressionThresholdPercent: 0.5  # proactive compression at half the model's context window

skills:
  directory: skills

browser:
  enabled: true
  port: 9322                # Chrome --remote-debugging-port
  headless: false           # headed so the user can log into shared accounts
```

Per-agent `model` / `tools` / `mcpServers` / `skills` override the root.
Schema source of truth: `packages/config/src/schema.ts`.

Agents are stored as folders under `~/.openacme/agents/<id>/`:
- `AGENT.md` — YAML frontmatter (`name`, `role`, `persona`, `model`, `tools`, …) + system-prompt body.
- `workspace/` — the agent's default cwd. Shell state persists across calls within a session.
- `resources/` — drop files here and they appear in the agent's prompt with absolute paths.
- `memory/` — `MEMORY.md` index + per-topic files.

Workforce-wide context goes in `~/.openacme/AGENTS.md` (editable from Settings → Context in the web UI) and is merged into every agent's prompt.

---

## 🧩 Workspace

Turborepo + pnpm 9. `apps/*` for binaries and UIs, `packages/*` for libraries.

| Package | Purpose |
|---|---|
| `apps/cli` | `openacme` binary — Commander + Ink TUI + Clack setup |
| `apps/web` | Next.js chat / agents / skills / settings |
| `apps/docs` | Docs site (placeholder) |
| `@openacme/agent-core` | Agentic loop, streaming, history reconstruction |
| `@openacme/server` | Hono HTTP server + `AgentManager` + auth middleware |
| `@openacme/llm-provider` | Six provider factories with OAuth-aware fetch |
| `@openacme/mcp-client` | MCP stdio + HTTP/SSE; tool discovery into the registry |
| `@openacme/tools` | `ToolRegistry` + built-in tools (shell, FS, web, browser, tasks, …) |
| `@openacme/browser` | Managed Chrome via CDP — shared user-data-dir, per-agent tab ownership |
| `@openacme/db` | better-sqlite3 + Drizzle; sessions / messages / task comments + events / FTS5 |
| `@openacme/memory` | Per-agent persistent `MEMORY.md` (Anthropic memory_20250818 + Claude Code convention) |
| `@openacme/tasks` | Workforce task store (filesystem; isolation by assignee) |
| `@openacme/config` | Zod schema + YAML/JSON loader + secret helpers |
| `@openacme/auth` | OAuth (ChatGPT, Claude), token store, body/response transforms |
| `@openacme/skills` | `SKILL.md` discovery + progressive disclosure + multi-source Skills Hub |
| `@repo/*` | Internal tooling (ui, eslint-config, typescript-config) |

---

## 🔧 Built-in tools

| Tool | What it does |
|---|---|
| `shell` | Run a shell command in the agent's workspace; persistent shell per session (`cd` / env / functions stick). 50KB output cap, destructive-pattern warning |
| `read_file` | Read a file, optionally `maxLines` |
| `write_file` | Write a file, creating parent dirs |
| `edit` | In-place find/replace edits |
| `apply_patch` | Apply a V4A-format multi-file patch |
| `list_files` | List a directory |
| `search_files` | Grep across files |
| `session_search` | FTS5 search across past conversations (system tool) |
| `skill_view` | Fetch a skill's full body on demand (system tool) |
| `web_search` / `web_extract` | Tavily / Exa / Brave search + page extraction |
| `execute_code` | Sandboxed code execution (Python REPL) |
| `process` | Background process management |
| `memory` | Read/write the agent's `MEMORY.md` and per-topic memory files (system tool) |
| `agent_list` | Look up coworkers — id, name, role, peer-notes (system tool) |
| `browser_*` | Managed Chrome via CDP — `navigate`, `snapshot`, `click`, `type`, `press_key`, `take_screenshot`, `wait_for`, `evaluate`, `console_messages`, `tabs`, `act` |
| `task_list` / `task_view` / `task_create` / `task_update` / `task_comment` / `task_comments` | Workforce task store (system tools) — `start_at`, `depends_on`, `recurrence` (cron / interval) all execute via the scheduler; comments + events live alongside in SQLite |

System tools are always on and not user-configurable. Plus any MCP-server tool, namespaced as `mcp-<server>__<tool>`.

---

## 🌐 Providers

| Provider | Auth modes | Notes |
|---|---|---|
| **Anthropic** | API key · OAuth (Claude Pro/Max) | `context-1m` for 4.6+ · 4.7+ sampling-param strip · `mcp_` tool-id strip |
| **OpenAI** | API key · OAuth (ChatGPT Plus/Pro) | OAuth flips to ChatGPT Responses API |
| **OpenRouter** | API key | Default in `ConfigSchema` |
| **Google** | API key | Standard Gemini |
| **Ollama** | — | Local, OpenAI-compatible |
| **Custom** | API key | Any OpenAI-compatible endpoint (`baseUrl` required) |

Adding a provider: enum + factory in `packages/llm-provider/src/registry.ts`.

---

## 🛡 Privacy & security

- Sessions, messages, and OAuth tokens live in **`~/.openacme/`** — no cloud, no telemetry.
- Server binds to **`127.0.0.1`** by default. `openacme expose` is required to open it to the network.
- Non-loopback requests require a secret (Bearer token or session cookie). Loopback is always trusted.
- The auth bypass is keyed on the `Host` header — ngrok and Cloudflare tunnels correctly require the secret even though they forward to `127.0.0.1`.
- The secret and OAuth tokens are written atomically at mode `0600`. Never logged in plaintext.
- MCP env injection is filtered — credential-shaped vars are dropped unless you list them explicitly in `mcpServers[name].env`.

---

## 🧪 Development

Two modes — pick the right one for what you're doing.

### `pnpm dev` — active development with hot reload

Use this when you're editing code. It:

- Auto-stops the daemon (frees port 3210)
- Starts every workspace package in `tsc --watch` (recompiles on save)
- Starts the server with `tsx watch src/index.ts` (hot-restarts on backend changes)
- Starts Next dev on a private port (`:3220`, loopback) with HMR; Hono on `:3210` fronts it — `/api/*` is handled in-process, everything else (including HMR over WebSocket) is proxied to Next

```sh
pnpm dev
# open http://localhost:3210   (one URL — same as the daemon)
```

What hot-reloads:

| Edit | Reloads automatically? |
|---|---|
| `apps/web/**` | Yes — Next.js HMR |
| `packages/server/**` | Yes — tsx watch restarts the server |
| `packages/agent-core/**`, `packages/tools/**`, etc. | Yes — their `tsc --watch` rebuilds dist/, server picks it up and restarts |
| `apps/cli/**` | Recompiles to dist/, but the daemon isn't running in dev mode |

When you stop `pnpm dev`, run `pnpm agent start` to bring the daemon back up if you want it always-on again.

To run a second `pnpm dev` in parallel (e.g. against a separate test data dir), just point it at a different data dir:

```sh
OPENACME_DATA_DIR=~/.openacme-test pnpm dev
# requires ~/.openacme-test/config.yaml with a different server.port (e.g. 3219)
```

The web dev port is derived as `server.port + 10`, so distinct API ports automatically give distinct web ports. One knob (`server.port`), no env-var ceremony.

### Daemon mode — production-style local install

Use this when you're *using* OpenAcme, not editing it. The daemon runs in the background, survives reboots, restarts on crash, and serves the production-built web bundle from `:3210`.

```sh
pnpm agent start       # background daemon at http://localhost:3210
```

In published installs the daemon serves the static UI from `packages/server/web/` (copied in by `prepack`). In the workspace, the daemon (without `OPENACME_DEV_PROXY_TARGET`) is API-only — use `pnpm dev` if you want the UI with HMR on `:3210`.

---

## 📜 Scripts

```sh
pnpm dev               # active dev (HMR + hot-restart) — http://localhost:3210
pnpm build             # build everything
pnpm check-types       # tsc --noEmit across the workspace
pnpm lint
pnpm test              # vitest where present
pnpm format            # prettier
```

Daemon lifecycle:

```sh
pnpm agent             # start daemon (idempotent, opens browser)
pnpm agent start       # same as above
pnpm agent stop        # stop daemon
pnpm agent restart     # restart daemon
pnpm agent status      # pid, bind, uptime, health, recent log
pnpm agent logs        # print last 200 log lines
pnpm agent logs -f     # follow the log live (Ctrl-C to quit)
```

Remote access:

```sh
pnpm agent start --expose  # open to network + generate secret
pnpm agent secret          # print current secret
pnpm agent secret rotate   # generate a new secret (invalidates sessions)
```

Other:

```sh
pnpm agent setup       # interactive setup wizard
pnpm agent chat        # terminal chat (in-process, no server needed)
```

Direct CLI (after `pnpm build`):

```sh
openacme start              # start daemon (default subcommand)
openacme start --expose     # start + open to network + generate secret
openacme stop
openacme restart
openacme status
openacme logs [-f]
openacme secret             # print secret
openacme secret rotate      # generate new secret
openacme setup         # wizard
openacme chat          # terminal chat
openacme login [--provider anthropic|openai]
openacme logout
openacme skills list
openacme mcp list
```

Per-package: `pnpm --filter @openacme/<pkg> <script>`.

---

## 🤝 Contributing

- **Release workflow** (Changesets, manual `gh workflow run`): see [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- **Codebase navigation** for AI assistants: [`CLAUDE.md`](./CLAUDE.md) is the dense map — request path, registries, gotchas, file:line refs.

---

<div align="center">

**MIT** © [Utkarsh Kanwat](mailto:utkarshkanwat@gmail.com) · [github.com/ukanwat/OpenAcme](https://github.com/ukanwat/OpenAcme)

</div>
