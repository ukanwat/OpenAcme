# OpenAcme — Roadmap

What's built, what's open, what's deferred. `.hermes-ref/` paths are mining references, not parity targets.

---

## Built-in tools

**Shipped (12 tools across 9 files in `packages/tools/src/builtins/`):**

- File ops: `read_file`, `write_file`, `list_files`, `search_files`
- Code editing: `edit` (cascade match: simple → line-trimmed → block-anchor → whitespace-normalized), `apply_patch` (V4A multi-file, atomic)
- Execution: `shell`, `execute_code` (persistent Python REPL via sidecar), `process` (background process management)
- Web: `web_search` (Tavily / Exa / Brave), `web_extract` (Mozilla Readability + Turndown)
- History: `session_search` (FTS5 across messages, session-aware via AsyncLocalStorage)

Plus dynamic MCP tools, namespaced `mcp-<server>__<tool>`.

**Open — high impact:**

- [ ] `clarify` — ask the user mid-turn when intent is ambiguous. No equivalent today; agent has to guess or fail.
- [ ] `memory` — persistent agent memory (e.g. SOUL.md / MEMORY.md / USER.md). Sessions persist; the agent doesn't.
- [ ] `delegate_task` — spawn a subagent for parallel / isolated work. Ref: `.hermes-ref/tools/delegate_tool.py`.
- [ ] `vision_analyze` — image input via vision-capable models.

**Open — additive:**

- [ ] Browser automation suite (12 tools: navigate, snapshot, click, type, scroll, back, press, get_images, vision, console, cdp, dialog). Ref: `.hermes-ref/tools/browser_tool.py`.
- [ ] `image_generate`, `text_to_speech`, audio transcription.
- [ ] Task management: `todo`, kanban suite.
- [ ] `cronjob` — scheduled task execution.
- [ ] `send_message` — multi-platform messaging gateway.

---

## Architecture / foundations

These change what the platform *can* do, independent of any single tool.

### Memory system

**State:** none.
**Why it matters:** without memory, the agent forgets across sessions; user has to re-establish context every time.
**Sketch:**
- `MemoryManager` orchestrating one or more providers
- Built-in provider over markdown files in `~/.openacme/memory/` (SOUL / MEMORY / USER pattern)
- Plugin slot for external providers (Honcho, Mem0, Supermemory, etc. — see `.hermes-ref/plugins/memory/`)
- System-prompt injection of relevant memories pre-turn
- Streaming context scrubber so memory tags don't leak in deltas

### Context compression

**State:** none. `behavior.maxIterations: 90` is a hard ceiling.
**Why it matters:** long conversations hit the model context window with no graceful degrade.
**Sketch:**
- Token counting per provider/model
- LLM-based summarization of older messages
- Session splitting via `parent_session_id` chains (already in schema for `messages` indirectly via `sessions`; would need explicit field)
- Provider-specific prompt cache awareness
- Ref: `.hermes-ref/trajectory_compressor.py`

### Approval / guardrails

**State:** `shell.ts` has a destructive-pattern *warning*; no real approval flow.
**Why it matters:** can't safely expand tool surface (delegate, browser, etc.) without it.
**Sketch:**
- Command classifier (safe / requires-approval / blocked)
- Per-user / per-agent allowlists & blocklists
- Approval request → user decision → execute, with audit log
- Path safety validator for file ops
- URL safety validator for web tools
- Ref: `.hermes-ref/tools/approval.py`, `path_security.py`, `url_safety.py`

### Terminal backends

**State:** local only.
**Open backends:** Docker, SSH, Modal (serverless GPU), Daytona, Vercel sandbox, Singularity (HPC).
**Each needs:** file sync, streaming output, process registry, env var injection, working-directory isolation.
**Ref:** `.hermes-ref/tools/environments/`.

### Web ↔ server auth

**State:** none — assumes a trusted local environment.
**Open:** session/token layer before exposing the server beyond loopback or building features that imply auth.

### Tests

**State:** vitest wired; most packages have no specs.
**Open:** unit tests for tools, integration tests for the agent loop, E2E for the HTTP routes, CLI command tests.

---

## Skills system

**State:** discovery + progressive disclosure shipped (`packages/skills`). Empty catalog.

**Open:**
- Bundled skill catalog
- Skills Hub integration (agentskills.io)
- FTS5 search across skill bodies
- Skill versioning, dependencies, prerequisites checking
- Auto-creation of skills from complex tasks

---

## CLI surface

**State:** `/new`, `/clear`, `/help`, `/exit`, `/model`, `/agent` in the Ink TUI; `setup`, `start`, `chat`, `login`, `logout` as binary subcommands.

**Open slash commands:**
- `/retry`, `/undo` — turn-level undo
- `/compress`, `/usage` — context management visibility
- `/memory` — memory operations
- `/skills` — browse / activate
- `/tools` — enable / disable
- `/doctor` — install diagnostics
- `/export`, `/import` — session portability

**Open features:**
- Slash-command autocomplete (already paletted, just sparse)
- Conversation history browsing
- Per-provider rate / cost tracking displayed in the TUI

---

## Messaging gateway

**State:** none.

Hermes runs as a bot on 35+ platforms (Telegram, Discord, Slack, WhatsApp, Signal, Email, Matrix, etc.). Open question whether OpenAcme wants any of this — if yes, the architecture is well-trodden in `.hermes-ref/gateway/` and the platform adapter pattern (`gateway/platforms/base.py`) is the entry point.

---

## Configuration & ops

**State:** interactive `setup` wizard ships; merges into existing config without overwriting.

**Open:**
- `doctor` command for diagnostics (config validation, auth health, MCP connectivity, tool checks)
- Multi-profile support
- Config migration across versions
- Dockerfile / Homebrew formula / install script for non-`pnpm install` distribution

---

## Deferred / out of scope (for now)

- RL training tools (the 10 `rl_*` tools in `.hermes-ref/tools/rl_training_tool.py`) — orthogonal to the agent platform.
- Most platform-specific integrations (Feishu, Yuanbao, Home Assistant, Discord-as-tool) — only worth pulling in if a real user case appears.
- Mixture-of-agents routing — interesting but blocked on `delegate_task` landing first.

---

## Recommended next-up

If picking three things that pay back the most for the least surface area:

1. **Memory system** + **context compression** — the pair unlocks long-running, persistent agents.
2. **Approval / guardrail layer** — required before safely growing the tool surface.
3. **`clarify` tool** — small change, immediately makes the agent feel less brittle.

Everything else is additive and can be sequenced after.
