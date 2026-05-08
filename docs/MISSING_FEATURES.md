# OpenAcme - Missing Features & Gaps

This document outlines features present in the Hermes reference implementation (`.hermes-ref/`) that OpenAcme currently lacks.

---

## Tools Gap

### Current State: 9 tools
### Target State: 69+ tools

| Category | Hermes Has | OpenAcme Has | Gap |
|----------|------------|--------------|-----|
| File Operations | 4 | 6 | `edit` + `apply_patch` (V4A multi-file) implemented |
| Terminal/Execution | 3 | 1 | `execute_code`, `process` missing |
| Browser Automation | 11 | 0 | Full suite missing |
| Web Tools | 2 | 2 | `web_search` (Tavily/Exa/Brave) + `web_extract` (Mozilla Readability) implemented |
| Vision & Media | 3 | 0 | `vision_analyze`, `image_generate`, `text_to_speech` missing |
| Skills Management | 3 | 0 | `skills_list`, `skill_view`, `skill_manage` missing |
| Memory & Sessions | 2 | 0 | `memory`, `session_search` missing |
| Task Management | 8 | 0 | Full kanban suite missing |
| Scheduling | 1 | 0 | `cronjob` missing |
| Agent Delegation | 2 | 0 | `delegate_task`, `mixture_of_agents` missing |
| Communication | 1 | 0 | `send_message` (35+ platforms) missing |
| Platform Integrations | 16 | 0 | Discord, Feishu, Yuanbao, Home Assistant missing |
| RL Training | 10 | 0 | Full RL suite missing |
| Utility | 2 | 0 | `clarify`, MCP dynamic tools missing |

### Priority Tools to Implement

**P0 - Critical:**
- [x] `edit` - Search/replace code-editing primitive (cascade: simple → line-trimmed → block-anchor → whitespace-normalized)
- [x] `apply_patch` - V4A multi-file patches (add / update / delete / move) with atomic rollback
- [x] `web_search` - Tavily / Exa / Brave provider abstraction
- [x] `web_extract` - Mozilla Readability + Turndown (markdown / text / html)
- [ ] `clarify` - Ask user for clarification
- [ ] `memory` - Persistent agent memory (SOUL.md, MEMORY.md, USER.md)
- [x] `session_search` - FTS5 search across conversation history

**P1 - High:**
- [ ] `delegate_task` - Spawn subagents for parallel work
- [ ] `execute_code` - Python REPL execution
- [ ] `process` - Background process management
- [ ] `vision_analyze` - Image analysis with vision models
- [ ] `image_generate` - Image generation

**P2 - Medium:**
- [ ] `browser_*` suite (11 tools) - Full browser automation
- [ ] `cronjob` - Scheduled task execution
- [ ] `kanban_*` suite (7 tools) - Task management
- [ ] `todo` - Personal TODO management
- [ ] `text_to_speech` - TTS capability

**P3 - Platform Integrations:**
- [ ] `send_message` - Multi-platform messaging gateway
- [ ] `discord_*` - Discord integration
- [ ] `ha_*` - Home Assistant smart home
- [ ] `feishu_*` - Feishu/Lark integration

---

## Messaging Gateway

### Current State: None
### Target State: 35+ platforms

Hermes supports running as a bot on:
- Telegram
- Discord
- Slack
- WhatsApp
- Signal
- Email
- SMS
- WeChat (Weixin)
- DingTalk
- Feishu/Lark
- WeChat Work
- QQ
- Matrix
- Mattermost
- IRC
- And 20+ more...

**What's Needed:**
- [ ] Gateway architecture (`gateway/run.py` equivalent)
- [ ] Platform adapter abstraction
- [ ] Concurrent platform handling
- [ ] Voice transcription across platforms
- [ ] Cross-platform session continuity
- [ ] Platform-specific auth flows
- [ ] Media handling (images, documents, voice)
- [ ] Rate limiting per platform

---

## Memory System

### Current State: None
### Target State: 8 memory providers

**Missing Components:**
- [ ] `MemoryManager` - Orchestrates memory providers
- [ ] Built-in memory provider (SOUL.md, MEMORY.md, USER.md)
- [ ] Plugin architecture for external providers:
  - [ ] Honcho (dialectic user modeling)
  - [ ] Mem0
  - [ ] Supermemory
  - [ ] Holographic (embeddings-based)
  - [ ] Others...
- [ ] System prompt generation with memory context
- [ ] Pre-turn prefetch, post-turn sync
- [ ] Streaming context scrubber
- [ ] Context fencing (prevent injection)

---

## Terminal Backends

### Current State: Local only
### Target State: 6 backends

**Missing Backends:**
- [ ] Docker - Containerized execution with file sync
- [ ] SSH - Remote machine execution
- [ ] Modal - Serverless GPU cloud (hibernates when idle)
- [ ] Daytona - Managed dev environments
- [ ] Singularity - HPC clusters
- [ ] Vercel Sandbox - Serverless execution

**Each Backend Needs:**
- [ ] File synchronization
- [ ] Streaming output with structured logging
- [ ] Process registry
- [ ] Checkpoint management
- [ ] Environment variable injection
- [ ] Working directory isolation

---

## Cron Scheduler

### Current State: None
### Target State: Full scheduler

**Missing:**
- [ ] `scheduler.py` equivalent - Tick-based job execution
- [ ] Job definitions and storage
- [ ] File-based locking for multi-process safety
- [ ] Per-job toolset overrides
- [ ] Delivery to any messaging platform
- [ ] Timezone-aware scheduling
- [ ] Natural language job creation

---

## Skills System

### Current State: Basic skeleton
### Target State: 100+ bundled skills across 26 categories

**Missing Categories:**
- [ ] `software-development/` (13 skills)
- [ ] `productivity/` (11 skills)
- [ ] `research/` (8 skills)
- [ ] `creative/` (22 skills)
- [ ] `github/` (9 skills)
- [ ] `mlops/` (10 skills)
- [ ] And 20+ more categories...

**Missing Infrastructure:**
- [ ] Skills Hub integration (agentskills.io)
- [ ] FTS5 search across skill content
- [ ] Skill versioning & dependencies
- [ ] Platform restrictions (macOS, Linux, Windows)
- [ ] Prerequisites checking (env vars, commands)
- [ ] Linked files & templates
- [ ] Auto-creation of skills from complex tasks

---

## CLI Commands

### Current State: ~5 commands
### Target State: 50+ commands

**Missing Commands:**
- [ ] `/new`, `/reset` - Session management
- [ ] `/model` - Switch LLM provider/model
- [ ] `/personality` - Set agent persona
- [ ] `/retry`, `/undo` - Undo last turn
- [ ] `/compress`, `/usage` - Context management
- [ ] `/skills` - Browse & activate skills
- [ ] `/platforms` - Gateway status
- [ ] `/logs`, `/doctor` - Diagnostics
- [ ] `/kanban` - Task board
- [ ] `/tools` - Enable/disable tools
- [ ] `/memory` - Memory operations
- [ ] `/goal`, `/focus` - Goal tracking
- [ ] And 35+ more...

**Missing CLI Features:**
- [ ] Multi-line editing with prompt_toolkit
- [ ] Slash-command autocomplete
- [ ] Conversation history browsing
- [ ] Streaming output with syntax highlighting
- [ ] Rich formatting (tables, boxes, colors)

---

## Advanced Features

### Tool Guardrails & Safety
- [ ] Approval workflows for dangerous operations
- [ ] Command allowlist/blocklist
- [ ] File path safety validation
- [ ] Dry-run mode (preview without executing)

### Context Management
- [ ] Token budget management
- [ ] Message summarization/compression
- [ ] Session splitting via parent_id chains
- [ ] Provider-specific prompt caching

### Rate Limiting & Cost
- [ ] Per-provider rate tracking
- [ ] Retry logic with backoff
- [ ] Multi-account billing support
- [ ] Cost tracking per session

### MCP Enhancements
- [ ] Dynamic tool discovery from MCP servers
- [ ] HTTP, stdio, custom transports
- [ ] Per-server timeout configuration
- [ ] Sampling support
- [ ] OAuth integration for MCP

### RL Training (Optional/Advanced)
- [ ] Environment framework (Atropos, gymnasium)
- [ ] Training configuration management
- [ ] Batch trajectory generation
- [ ] Results tracking

---

## Configuration & Setup

**Missing:**
- [ ] Interactive setup wizard (`openacme setup`)
- [ ] Doctor command for diagnostics (`openacme doctor`)
- [ ] Profile-aware paths (multiple user profiles)
- [ ] Config migration across versions
- [ ] Atomic YAML writes (prevent corruption)

---

## Testing

### Current State: 0 tests
### Target State: Comprehensive coverage

**Needed:**
- [ ] Unit tests for tools
- [ ] Integration tests for agent loop
- [ ] E2E tests for API endpoints
- [ ] Platform adapter tests
- [ ] CLI command tests

---

## Deployment

**Missing:**
- [ ] Dockerfile
- [ ] Homebrew formula
- [ ] Install script (Linux/macOS/Termux)
- [ ] Nix package
- [ ] npm/npx distribution

---

## Summary Statistics

| Metric | Hermes | OpenAcme | Gap |
|--------|--------|----------|-----|
| Built-in Tools | 69 | 9 | 60 |
| Messaging Platforms | 35+ | 0 | 35+ |
| Memory Providers | 8 | 0 | 8 |
| Skill Categories | 26 | 0 | 26 |
| Terminal Backends | 6 | 1 | 5 |
| CLI Commands | 50+ | ~5 | 45+ |
| Tests | ~15,000 | 0 | ~15,000 |

---

## Recommended Implementation Order

### Phase 1: Core Tools
1. `patch` tool
2. `web_search` + `web_extract`
3. `clarify` tool
4. `memory` tool
5. `session_search` with FTS5

### Phase 2: Agent Capabilities
6. `delegate_task` for subagents
7. `execute_code` Python REPL
8. `process` management
9. Context compression
10. Tool guardrails

### Phase 3: CLI Enhancement
11. Rich CLI with 20+ commands
12. Setup wizard
13. Doctor diagnostics
14. Slash-command autocomplete

### Phase 4: Platform Integrations
15. Gateway architecture
16. Telegram adapter
17. Discord adapter
18. Slack adapter

### Phase 5: Advanced
19. Browser automation suite
20. Vision tools
21. Image generation
22. Cron scheduler
23. Multiple terminal backends
