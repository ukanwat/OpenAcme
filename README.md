<div align="center">

# ◢◤ OpenAcme

**A local-first TypeScript agent platform.**
Streaming tool-calls. Multi-provider LLMs. ChatGPT & Claude OAuth. MCP. Built-in CLI + web UI.

<sub>Pre-1.0 · Single-author · Evolving fast — expect breaking changes.</sub>

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-f69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Turborepo](https://img.shields.io/badge/Turborepo-monorepo-ef4444)](https://turborepo.com/)
[![License](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)

</div>

---

## ✦ Why OpenAcme

> Most agent platforms ask you to pay for API credits *and* a subscription. OpenAcme lets your existing ChatGPT or Claude subscription drive the agent — locally, with full session history, MCP tools, and a chat UI you actually own.

- 🔌 **Bring your own model.** Six providers, one config — swap them per agent.
- 🔑 **Sign in, don't pay twice.** OAuth into ChatGPT (Plus/Pro) or Claude (Pro/Max); API keys remain a fallback.
- 🛠 **Tools that compose.** Built-in shell + filesystem + session search; add any MCP server and its tools show up automatically.
- 💾 **Sessions stay yours.** SQLite + FTS5 in `~/.openacme/`; no cloud, no telemetry, no external state.
- 🧠 **Skills as context.** Drop `SKILL.md` files in; the agent gets a tag-indexed summary, fetches the body on demand.
- 🖥 **Two interfaces, one runtime.** A React-on-Ink TUI and a Next.js web UI, both backed by the same Hono server.
- 🔄 **Always-on daemon.** Managed by launchd (macOS) or systemd-user (Linux) — survives reboots and crashes.

---

## ⚡ Quickstart

```sh
git clone git@github.com:ukanwat/OpenAcme.git
cd OpenAcme
pnpm install              # pnpm 9 · Node ≥ 18
pnpm build
pnpm agent:setup          # interactive wizard → ~/.openacme/config.yaml
pnpm agent                # starts background daemon + opens the web UI
```

The daemon registers itself with launchd (macOS) or systemd-user (Linux) on first run. It auto-starts at login and auto-restarts on crash. Subsequent `openacme start` calls are idempotent.

Or skip the browser and chat in the terminal:

```sh
pnpm agent:chat           # in-process terminal chat (no server needed)
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
pnpm agent:start --expose
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
  maxSteps: 10
  maxIterations: 90

skills:
  directory: skills
```

Per-agent `model` / `tools` / `mcpServers` / `skills` override the root.
Schema source of truth: `packages/config/src/schema.ts`.

Agents are stored as files under `~/.openacme/agents/<id>/AGENT.md` — editable directly in any text editor.

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
| `@openacme/tools` | `ToolRegistry` + built-in tools |
| `@openacme/db` | better-sqlite3 + Drizzle, FTS5-backed message search |
| `@openacme/config` | Zod schema + YAML/JSON loader + secret helpers |
| `@openacme/auth` | OAuth (ChatGPT, Claude), token store, body/response transforms |
| `@openacme/skills` | `SKILL.md` discovery + progressive disclosure |
| `@repo/*` | Internal tooling (ui, eslint-config, typescript-config) |

---

## 🔧 Built-in tools

| Tool | What it does |
|---|---|
| `shell` | Run a shell command (timeout · 50KB output cap · destructive-pattern warning) |
| `read_file` | Read a file, optionally `maxLines` |
| `write_file` | Write a file, creating parent dirs |
| `list_files` | List a directory |
| `search_files` | Grep across files |
| `session_search` | FTS5 search across past conversations |

Plus any MCP-server tool, namespaced as `mcp-<server>__<tool>`.

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

## 📜 Scripts

```sh
pnpm dev               # web + @openacme/server in parallel (dev mode, not the daemon)
pnpm build             # build everything
pnpm check-types       # tsc --noEmit across the workspace
pnpm lint
pnpm test              # vitest where present
pnpm format            # prettier
```

Daemon lifecycle:

```sh
pnpm agent             # start daemon (idempotent, opens browser)
pnpm agent:start       # same as above
pnpm agent:stop        # stop daemon
pnpm agent:restart     # restart daemon
pnpm agent:status      # pid, bind, uptime, health, recent log
pnpm agent:logs        # print last 200 log lines
pnpm agent:logs -f     # follow the log live (Ctrl-C to quit)
```

Remote access:

```sh
pnpm agent:start --expose  # open to network + generate secret
pnpm agent:secret          # print current secret
pnpm agent:secret rotate   # generate a new secret (invalidates sessions)
```

Other:

```sh
pnpm agent:setup       # interactive setup wizard
pnpm agent:chat        # terminal chat (in-process, no server needed)
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
