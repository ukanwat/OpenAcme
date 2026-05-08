---
paths:
  - "apps/cli/**"
---

# cli

Commander entrypoint + Ink TUI + Clack setup wizard. The `openacme` binary. Subcommands run **in-process** — terminal chat does not call the HTTP server.

## `chat` is in-process, not over HTTP

`commands/chat.ts` instantiates `AgentManager` directly and iterates `agent.chat()`. Server-only middleware/routes (CORS, body parsers, future auth layer) **do not affect terminal chat behavior.**

- Implication: changes to the agent loop must be verified against both `pnpm agent:chat` (CLI) and the web UI's `/api/chat` path. They share `Agent` but not the wrapping plumbing.
- Don't move `chat` to HTTP "for consistency" — the in-process path is faster, doesn't need a server running, and is the canonical scripting path.

## `OPENACME_DATA_DIR` is set early — do not move

`apps/cli/src/index.ts:115`: argv is parsed, the data dir resolved, and `process.env["OPENACME_DATA_DIR"]` is set **before** any package loads config or `auth.json`. Downstream packages (auth, llm-provider) read this synchronously and will silently use `~/.openacme` if it isn't set.

- Don't load config earlier than this. Don't drop the env-var write — auth refresh in `getOAuthToken()` needs it.
- New subcommand? Same pattern: parse argv → set env → load config → run.

## Slash commands dispatch through the reducer

`tui/commands.ts` is the slash-command table (`/new`, `/clear`, `/help`, `/exit`, `/model`, `/agent`). Each entry maps to a reducer action in `tui/state.ts`.

- Don't put side effects in command handlers. Dispatch an action; the reducer or a `useEffect` handles the side effect.
- New slash command: add the entry, add the action type, handle it in the reducer. UI updates flow through component re-render.

## TTY detection is binary

`commands/chat.ts:35`: `process.stdout.isTTY === true && process.stdin.isTTY === true` → Ink TUI. Otherwise `headless.ts` streams to stdout line-by-line.

- Semi-interactive pipes (expect, paramiko, CI logs) hit the headless path. Design new TUI features so the headless path still produces useful output.
- Don't add "partial TTY" branches — two paths is enough complexity.

## TUI structure (Ink + React)

- `render.tsx` mounts the app
- `App.tsx` is the root component
- `state.ts` reducer
- `commands.ts` command table
- `components/` — `MessageList`, `MessageBubble`, `ToolBlock`, `MultilineInput`, `ModelPicker`, `AgentPicker`, `StatusLine`, `Banner`, `CommandPalette`
- `markdown.ts` — `marked` + `marked-terminal` for rendering assistant responses

Match an existing component's font/border/spacing before adding a new banner or card. There's a feedback memory enforcing this codebase-wide.

## No tests

Verify TUI changes by running `pnpm agent:chat` against a real agent. There's no fixture path; reproducibility comes from a known config + a model that can run cheaply (Sonnet works).
