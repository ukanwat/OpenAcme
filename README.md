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

---

## ⚡ Quickstart

```sh
git clone git@github.com:ukanwat/OpenAcme.git
cd OpenAcme
pnpm install              # pnpm 9 · Node ≥ 18
pnpm build
pnpm agent:setup          # interactive wizard → ~/.openacme/config.yaml
pnpm agent                # launches server + opens the web UI
```

Or skip the browser:

```sh
pnpm agent:chat           # in-process terminal chat (no server)
```

### Sign in with a subscription

```sh
pnpm agent login --provider anthropic    # Claude Pro / Max
pnpm agent login --provider openai       # ChatGPT Plus / Pro
```

Tokens land in `~/.openacme/auth.json` (mode `0600`) and auto-refresh.
The `@openacme/llm-provider` factories pick them up when no API key is configured.

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
  host: 127.0.0.1             # loopback only by default

behavior:
  maxSteps: 10
  maxIterations: 90

skills:
  directory: skills

agents:
  - id: default
    name: Default
    persona: You are a helpful AI assistant.
    tools: [shell, read_file, write_file, list_files, search_files, session_search]
    mcpServers: {}
    skills: []
```

Per-agent `model` / `tools` / `mcpServers` / `skills` override the root.
Schema source of truth: `packages/config/src/schema.ts`.

---

## 🧩 Workspace

Turborepo + pnpm 9. `apps/*` for binaries and UIs, `packages/*` for libraries.

| Package | Purpose |
|---|---|
| `apps/cli` | `openacme` binary — Commander + Ink TUI + Clack setup |
| `apps/web` | Next.js chat / agents / skills / settings |
| `apps/docs` | Docs site (placeholder) |
| `@openacme/agent-core` | Agentic loop, streaming, history reconstruction |
| `@openacme/server` | Hono HTTP server + `AgentManager` |
| `@openacme/llm-provider` | Six provider factories with OAuth-aware fetch |
| `@openacme/mcp-client` | MCP stdio + HTTP/SSE; tool discovery into the registry |
| `@openacme/tools` | `ToolRegistry` + built-in tools |
| `@openacme/db` | better-sqlite3 + Drizzle, FTS5-backed message search |
| `@openacme/config` | Zod schema + YAML/JSON loader |
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

## 🛡 Privacy & local-first

- Sessions, messages, and OAuth tokens live in **`~/.openacme/`** — no cloud, no telemetry.
- Server binds to **`127.0.0.1`** by default. Change `server.host` only if you've thought about it.
- The local web ↔ server channel has **no auth** today; assumes a trusted machine.
- MCP env injection is filtered — credential-shaped vars are dropped unless you list them explicitly in `mcpServers[name].env`.
- OAuth tokens are written atomically at mode `0600`. Never logged in plaintext.

---

## 📜 Scripts

```sh
pnpm dev               # web + @openacme/server in parallel
pnpm build             # build everything
pnpm check-types       # tsc --noEmit across the workspace
pnpm lint
pnpm test              # vitest where present
pnpm format            # prettier

pnpm agent             # CLI (no subcommand → start)
pnpm agent:setup       # interactive setup wizard
pnpm agent:start       # server + web UI
pnpm agent:chat        # terminal chat (in-process, no server)

pnpm changeset         # declare a version bump
pnpm version-packages
pnpm release           # build @openacme/* + changeset publish
```

Per-package: `pnpm --filter @openacme/<pkg> <script>`.

---

## 🤝 Contributing

- **Release workflow** (Changesets, manual `gh workflow run`): see [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- **Codebase navigation** for AI assistants: [`CLAUDE.md`](./CLAUDE.md) is the dense map — request path, registries, gotchas, file:line refs.

---

<div align="center">

**MIT** © [Utkarsh Kanwat](mailto:utkarsh@autonomyai.io) · [github.com/ukanwat/OpenAcme](https://github.com/ukanwat/OpenAcme)

</div>
