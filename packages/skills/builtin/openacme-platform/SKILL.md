---
name: openacme-platform
description: How OpenAcme is laid out — data dir, agents, skills, MCP servers, tasks, memory, the peer-notes convention. Read this when the user asks you to manage their workforce, set up an agent, install a skill, configure an MCP server, or explain how the platform works.
tags: [platform, admin, reference]
---

# OpenAcme platform reference

OpenAcme is an AI-workforce platform — a set of role-specialized agents
working for a small human team. You are the platform-admin agent. The
user asks you to set up other agents, install skills, wire up MCP
servers, and explain how things work. This document is your reference
for all of that.

## Data directory layout

Every install has a single data directory (default `~/.openacme/`). The
user can override with `OPENACME_DATA_DIR`. Layout:

```
<dataDir>/
├── config.yaml             # platform config — top-level model, server port, browser
├── auth.json               # OAuth tokens (0600). NEVER touch.
├── .env                    # provider API keys. NEVER touch.
├── mcp-tokens/             # MCP OAuth state. NEVER touch.
├── state.db                # SQLite — sessions, messages, comments, events. NEVER write directly.
├── AGENTS.md               # shared workforce context — injected into every agent's prompt
├── mcp.json                # global MCP server catalog (inherited by every agent unless disabled)
├── skills/<name>/SKILL.md  # workforce-wide skills (you can write these)
├── agents/<id>/
│   ├── AGENT.md            # YAML frontmatter + persona body
│   ├── workspace/          # default cwd for the agent's shell + filesystem tools
│   ├── resources/          # user-supplied reference files (style guides, templates)
│   └── memory/
│       ├── MEMORY.md       # index, always injected into prompt
│       ├── <topic>.md      # entry files read on demand
│       └── peers/<id>.md   # notes about a coworker, from prior delegations
├── tasks/<id>.md           # one file per task (YAML frontmatter + body)
├── attachments/<sid>/<aid>/<file>   # chat file uploads
└── browser-profile/        # shared Chrome user-data-dir
```

**Off-limits files** (do not read, do not write, no exceptions):
`auth.json`, `.env`, `mcp-tokens/`, `state.db`. These are platform
secrets and corruption-prone state. If the user asks you to inspect
their provider credentials, tell them to check `<dataDir>/.env` or
`<dataDir>/auth.json` themselves — don't open the file.

## AGENT.md format

Each agent is a folder under `<dataDir>/agents/<id>/`. The id is the
folder name — renaming the folder renames the agent. The AGENT.md file
inside is YAML frontmatter + a markdown body for the persona.

```markdown
---
name: Coder
role: Owns implementation work and code review for the workforce. Reads
  existing patterns before writing new code. Hands off ambiguous design
  decisions to the user.
model:
  provider: anthropic
  model: claude-sonnet-4-20250514
  auth: oauth
tools: [shell, read_file, write_file, edit, apply_patch, list_files,
        search_files, web_search, web_extract, execute_code, process]
mcpServers: {}
mcpDisabled: []
skills: []
---

You are a senior software engineer. ...persona body in second-person...
```

Key fields:

- `name` — display name (any string).
- `role` — third-person paragraph for coworkers (used by `agent_list`).
- `model` — optional per-agent override; absent inherits the root
  `config.yaml`'s `model`.
- `tools` — environment-touching tools (shell, file IO, web, exec,
  browser). Introspection / self-management tools (`memory`,
  `skill_view`, `session_search`, `task_*`, `agent_list`, `ping_user`,
  `sleep`) are **always-on system tools** merged in automatically — do
  NOT list them here.
- `mcpServers` — agent-private MCP servers (names must not collide with
  global mcp.json).
- `mcpDisabled` — global mcp.json server names this agent should not
  receive.
- `skills` — empty/missing means "every installed skill"; non-empty is
  an allowlist.

When you create a new agent, write the AGENT.md directly. The folder
gets created on first read. Workspace and memory dirs are created
on-demand by the platform.

**Restart semantics.** Editing AGENT.md does not automatically
invalidate the running agent's cached system prompt. After non-trivial
AGENT.md edits, tell the user to restart the daemon (`openacme
restart`). Adding/removing agents follows the same rule.

## SKILL.md format

Skills live at `<dataDir>/skills/<name>/SKILL.md`. The name in the
frontmatter must match the directory name. Progressive disclosure: the
platform injects the index (name + description + tags) into every
agent's system prompt; the body is loaded on demand via `skill_view`.

```markdown
---
name: my-skill
description: One-line description. Be specific — this is what other
  agents read when deciding whether to load the body.
tags: [tag1, tag2]
---

# Skill title

Body — markdown. Loaded on demand. No length cap beyond 1MB. Companion
files in the same dir (examples, templates) are surfaced as
"resources" the agent can read.
```

**Authoring a good skill:**
- Description is the trigger — be specific about WHEN the skill applies.
- Body should be reference content, not a step-by-step script. The
  agent reads it and decides how to apply it.
- Companion files (examples, templates) sit next to SKILL.md and are
  surfaced as resources.
- Skills are not invokable — agents read them, they don't call them.

**Locally-authored vs installed.** A skill you write by hand into
`<dataDir>/skills/<name>/` is "locally-authored" — no lockfile entry,
no audit trail. SkillHub (the install pipeline) refuses to clobber
locally-authored skills. To install from GitHub / marketplaces, use the
`openacme skills install` CLI command or the web UI's Skills page; do
NOT write SKILL.md files into directories that already have a lockfile
entry.

## mcp.json shape

Global MCP catalog at `<dataDir>/mcp.json`. Same JSON shape that Claude
Desktop, Cursor, Cline use — users can paste configs from anywhere.

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
  },
  "github": {
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
  }
}
```

Per-server fields: `command` + `args` (stdio), `url` + optional
`transport: "http"|"sse"` (HTTP / SSE), `env` (forwarded as-is —
inherited env is filtered to drop credential-shaped vars like
`AWS_*` / `OPENAI_*` / `GITHUB_TOKEN`; pass them explicitly here if a
server actually needs them), `headers`, `timeout`, `connectTimeout`,
`enabled`, `allowedTools`.

**Restart semantics.** Editing mcp.json requires a daemon restart. The
platform reads it once at boot and on agent-config changes; there is no
file watcher. After editing, tell the user `openacme restart`.

Per-agent private servers go in `mcpServers` on AGENT.md (must not
collide with global names). Per-agent exclusions go in `mcpDisabled`.

## AGENTS.md (shared context)

`<dataDir>/AGENTS.md` is workforce-wide context injected into every
agent's system prompt below the persona. Use it for things ALL agents
should know: shared conventions, the human team's working style, repo
URLs, current initiatives.

You can edit it freely. After editing, the platform evicts cached
Agents automatically — no restart needed.

## Tasks

Tasks are filesystem-backed at `<dataDir>/tasks/<id>.md`. One file per
task, YAML frontmatter + markdown body.

**Lifecycle:** `open ↔ blocked` (auto-flip based on `depends_on`),
`→ in_progress` (claimed by assignee), `→ done | canceled` (terminal).
Recurring tasks self-reset to `open` with the next fire time when
marked `done`; use `canceled` to stop a recurrence permanently.

**At most one `in_progress` per session.** The platform enforces this.

**Comments vs body vs events:**
- **Body** is the spec — one voice, owned by the assigner / assignee.
- **Comments** (`task_comment` / `task_comments`) are the discussion
  thread — multi-voice, append-only. Kind `result` is the assignee's
  canonical answer at completion; kind `system` is scheduler-authored.
- **Events** are the signal log (status changes, comments, dep
  unblocks) — read-only, queried via `/api/tasks/:id/events`.

**Scheduler.** Pure event-driven. When a task event fires, the
scheduler wakes the assignee's session for one autonomous turn. The
agent picks what to work on from the prompt's task snapshot. No
periodic tick.

**Onboarding pattern.** When you create a new agent, file an
**onboarding task** on them: `task_create(assignee: <newId>, title:
"Onboarding: read your coworkers and save peer notes", body: "Run
agent_list to see your coworkers. For each one, write a short peer
note at /memories/peers/<id>.md describing what to delegate to them
and any lived nuance you'd want a future-you to know.")`. The new
agent picks it up autonomously on first wake and learns the team.

## Memory

Per-agent memory at `<dataDir>/agents/<id>/memory/`. Uses Anthropic's
`memory_20250818` tool spec — six ops (`view`, `create`, `str_replace`,
`insert`, `delete`, `rename`) against virtual paths under `/memories/`.

`MEMORY.md` is the index — always injected into the prompt. Cap 2200
chars (write-time). Entries live in topic files (`<topic>.md`) loaded
on demand.

**Peer notes.** Convention is `peers/<peerId>.md` — one note per
coworker keyed by stable agent id. Captures lived nuance from prior
delegations, NOT a paraphrase of the canonical role. The `agent_list`
tool surfaces peer notes inline so a delegating agent sees both
canonical role and their own learned context.

## How you set things up

When the user asks you to create a new agent:

1. Decide id, name, role, persona, tools, model (inherit from
   `config.yaml` if no specific reason).
2. Write `<dataDir>/agents/<id>/AGENT.md` with the frontmatter +
   persona body.
3. File an onboarding task on the new agent so they learn the team.
4. Tell the user to restart the daemon (`openacme restart`) so the new
   agent's prompt is built fresh.

When the user asks you to install a skill:

- If they want a workforce-wide skill they're authoring themselves:
  write `<dataDir>/skills/<name>/SKILL.md` directly.
- If they want to install from GitHub / a marketplace: use the
  `openacme skills install` CLI or the web Skills page. Don't paste a
  fetched SKILL.md by hand — the install pipeline handles trust,
  lockfile, and audit.

When the user asks you to add an MCP server:

1. Read `<dataDir>/mcp.json` (or create it as `{}` if missing).
2. Add the server entry (same shape Claude Desktop / Cursor use).
3. Tell the user to restart the daemon for the change to take effect.

When the user asks how something works:

- Walk through the relevant section of this skill in your own words.
- Reference your `resources/` folder — it has example AGENT.md /
  SKILL.md / mcp.json snippets you can show.
