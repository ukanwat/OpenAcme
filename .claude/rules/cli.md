---
paths:
  - "apps/cli/**"
---

# cli

Commander entrypoint + Ink TUI + Clack setup wizard. The `openacme` binary. Subcommands run **in-process** — terminal chat does not call the HTTP server.

## `chat` is in-process, calls `agent.runStream` directly

`commands/chat.ts` instantiates `AgentManager` directly. The TUI (or headless) calls `agent.runStream(...)` and consumes `result.fullStream` — no HTTP, no SSE, no UIMessageStream protocol. Server-only middleware/routes (CORS, body parsers, secret-cookie auth) **do not affect terminal chat behavior.**

- Implication: changes to the agent loop must be verified against both `pnpm agent:chat` (CLI) and the web UI's `/api/chat` path. They share `Agent` but the wrapping plumbing differs (server uses `createUIMessageStream`; CLI consumes `fullStream` directly).
- Don't move `chat` to HTTP "for consistency" — the in-process path is faster, doesn't need a server running, and is the canonical scripting path.

## TUI assembles the assistant UIMessage manually from `fullStream`

`App.tsx`'s `sendTurn`:
1. Commits any pending attachments to disk via `commitAttachmentForCli` (writes under `<attachmentsRoot>/<sessionId>/<attId>/<filename>` and emits a `FileUIPart` with the matching `/api/attachments/...` URL — the URL form mirrors the server's static-serve so a chat opened later in the web works).
2. Builds the user UIMessage and dispatches `user-submit`.
3. Calls `agent.runStream({ sessionId, history: [...committed, userMsg], signal })`.
4. Iterates `result.fullStream`, dispatching reducer actions for live render AND building a parallel `assistantParts: UIMessage["parts"]` accumulator.
5. On finish: appends `userMsg` + assembled assistant UIMessage to `messageStore` and dispatches `stream-done`.

The reducer (`state.ts`) carries `committed: UIMessage[]` and an in-flight `UIMessage | null` whose parts grow per `text-delta` / `tool-call` / `tool-result` / `tool-input-start` event.

- Don't try to use `result.response.messages` — that's `ModelMessage[]`, not `UIMessage[]`. Assemble from `fullStream` events.
- Ensure the session row exists BEFORE `runStream` — `getSystemPrompt` calls `sessionStore.updateSystemPrompt` and the message-append at the end has an FK to the session.

## Attachments: drag-drop + `@<path>` resolved at submit

`tui/attachments.ts` has the helpers; the input bar (`MultilineInput.tsx`) detects single-path pastes. Drag-and-drop into iTerm2 / Terminal.app / kitty / Windows Terminal arrives as a path string the terminal pastes — `looksLikeDroppedPath` filters to "single token, exists on disk, supported MIME"; on match, it's swallowed and dispatched as `attach-add`.

- `@<path>` tokens in the message are extracted at submit time via `extractAtPaths`. Resolved paths attach; unresolved ones surface as a one-shot notice and stay in the text so the user can fix them and re-send.
- Headless mode (`headless.ts`) does the same `@<path>` extraction on stdin.

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
- `state.ts` reducer (state carries `UIMessage[]`, actions are stream-* and attach-*)
- `commands.ts` command table
- `restore.ts` — `dbMessagesToTuiMessages` is near-identity (StoredUIMessage → UIMessage shape)
- `attachments.ts` — path normalize, mime sniff, FileUIPart commit
- `components/` — `MessageList`, `MessageBubble` (renders UIMessagePart[]), `ToolBlock` (accepts a ToolUIPart, renders by `state`), `MultilineInput`, `PendingAttachmentsBar`, `ModelPicker`, `AgentPicker`, `StatusLine`, `Banner`, `CommandPalette`
- `markdown.ts` — `marked` + `marked-terminal` for rendering assistant responses

Match an existing component's font/border/spacing before adding a new banner or card. There's a feedback memory enforcing this codebase-wide.

## No tests

Verify TUI changes by running `pnpm agent:chat` against a real agent. There's no fixture path; reproducibility comes from a known config + a model that can run cheaply (Sonnet works).
