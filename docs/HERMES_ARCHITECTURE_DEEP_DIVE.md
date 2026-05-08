# Hermes Architecture Deep Dive

Comprehensive reference of the Hermes implementation at `.hermes-ref/` with exact file paths, line counts, and implementation details.

---

## Core Files (Root Level)

| File | Lines | Size | Purpose |
|------|-------|------|---------|
| `run_agent.py` | ~18,000 | 722KB | Main AIAgent class, conversation loop, tool orchestration |
| `cli.py` | ~14,000 | 545KB | Interactive CLI with 50+ commands, prompt_toolkit UI |
| `hermes_state.py` | ~2,400 | 96KB | SQLite session store with FTS5, WAL mode |
| `model_tools.py` | ~900 | 35KB | Tool dispatch, schema generation, async bridging |
| `trajectory_compressor.py` | ~1,600 | 65KB | Context compression, message summarization |
| `batch_runner.py` | ~1,400 | 55KB | Parallel trajectory generation for RL |
| `toolsets.py` | ~700 | 28KB | Toolset configuration and grouping |
| `toolset_distributions.py` | ~300 | 12KB | Tool distribution across agents |
| `mcp_serve.py` | ~800 | 31KB | MCP server implementation |
| `utils.py` | ~300 | 11KB | Shared utilities |
| `hermes_constants.py` | ~350 | 13KB | Global constants |
| `hermes_logging.py` | ~350 | 14KB | Logging configuration |
| `hermes_time.py` | ~80 | 3KB | Time utilities |
| `rl_cli.py` | ~400 | 16KB | RL training CLI |
| `mini_swe_runner.py` | ~750 | 28KB | SWE benchmark runner |

---

## Tools Directory (`.hermes-ref/tools/`)

**Total: 53,073 lines across 74 files**

### Core Tool Files

| File | Lines | Purpose |
|------|-------|---------|
| `registry.py` | 538 | Central tool registry, schema management, dispatch |
| `file_tools.py` | 1,125 | `read_file`, `write_file`, `patch`, `search_files` |
| `terminal_tool.py` | 2,342 | Shell execution across 6 backends |
| `code_execution_tool.py` | 1,621 | Python REPL execution |
| `process_registry.py` | 1,434 | Background process management |

### Browser Automation

| File | Lines | Purpose |
|------|-------|---------|
| `browser_tool.py` | 2,991 | 10 browser tools (navigate, click, type, scroll, etc.) |
| `browser_supervisor.py` | 1,366 | Browser state management, lifecycle |
| `browser_cdp_tool.py` | ~400 | Raw CDP commands |
| `browser_dialog_tool.py` | ~200 | Dialog handling (alerts, confirms) |
| `browser_camofox.py` | ~600 | Camouflaged browser profiles |
| `browser_camofox_state.py` | ~300 | Browser profile state |

**Browser Providers (`tools/browser_providers/`):**
| File | Purpose |
|------|---------|
| `base.py` | Base provider interface |
| `browserbase.py` | Browserbase cloud provider |
| `firecrawl.py` | Firecrawl provider |
| `browser_use.py` | Browser-use provider |

### Web & Search

| File | Lines | Purpose |
|------|-------|---------|
| `web_tools.py` | 2,153 | `web_search`, `web_extract` |

### Vision & Media

| File | Lines | Purpose |
|------|-------|---------|
| `vision_tools.py` | ~500 | Image analysis with vision models |
| `image_generation_tool.py` | 1,002 | Multi-provider image generation |
| `tts_tool.py` | 2,191 | Text-to-speech with voice models |
| `transcription_tools.py` | ~400 | Audio transcription |
| `voice_mode.py` | 1,017 | Voice interaction mode |

### Skills System

| File | Lines | Purpose |
|------|-------|---------|
| `skills_tool.py` | 1,519 | `skills_list`, `skill_view` |
| `skill_manager_tool.py` | ~600 | Skill CRUD operations |
| `skills_hub.py` | 3,225 | Skills Hub integration (agentskills.io) |
| `skills_sync.py` | ~300 | Skill synchronization |
| `skills_guard.py` | ~200 | Skill security validation |
| `skill_usage.py` | ~150 | Skill usage tracking |

### Memory & Sessions

| File | Lines | Purpose |
|------|-------|---------|
| `memory_tool.py` | ~400 | Memory read/write (SOUL.md, MEMORY.md, USER.md) |
| `session_search_tool.py` | ~500 | FTS5 search across sessions |

### Task Management

| File | Lines | Purpose |
|------|-------|---------|
| `todo_tool.py` | ~300 | Personal TODO management |
| `kanban_tools.py` | ~800 | 7 kanban board tools |

### Scheduling

| File | Lines | Purpose |
|------|-------|---------|
| `cronjob_tools.py` | ~400 | Cron job management |

### Agent Delegation

| File | Lines | Purpose |
|------|-------|---------|
| `delegate_tool.py` | 2,531 | Subagent spawning, parallel execution |
| `mixture_of_agents_tool.py` | ~600 | Multi-agent routing |

### Communication

| File | Lines | Purpose |
|------|-------|---------|
| `send_message_tool.py` | 1,742 | Cross-platform messaging (35+ platforms) |

### Platform Integrations

| File | Lines | Purpose |
|------|-------|---------|
| `discord_tool.py` | 947 | Discord operations |
| `homeassistant_tool.py` | ~500 | Home Assistant smart home |
| `feishu_doc_tool.py` | ~400 | Feishu document reading |
| `feishu_drive_tool.py` | ~600 | Feishu drive operations |
| `yuanbao_tools.py` | ~500 | Yuanbao platform tools |

### MCP Integration

| File | Lines | Purpose |
|------|-------|---------|
| `mcp_tool.py` | 3,145 | Dynamic MCP tool discovery & registration |
| `mcp_oauth.py` | ~400 | OAuth for MCP servers |
| `mcp_oauth_manager.py` | ~300 | OAuth token management |

### RL Training

| File | Lines | Purpose |
|------|-------|---------|
| `rl_training_tool.py` | 1,396 | 10 RL training tools |

### Safety & Security

| File | Lines | Purpose |
|------|-------|---------|
| `approval.py` | 1,245 | Command approval workflows |
| `path_security.py` | ~200 | File path validation |
| `url_safety.py` | ~150 | URL validation |
| `tirith_security.py` | ~300 | Security policies |
| `credential_files.py` | ~200 | Credential detection |
| `website_policy.py` | ~250 | Website access policies |

### Utility

| File | Lines | Purpose |
|------|-------|---------|
| `clarify_tool.py` | ~200 | Ask user for clarification |
| `file_operations.py` | 1,257 | Low-level file operations |
| `file_state.py` | ~300 | File state tracking |
| `patch_parser.py` | ~400 | Unified diff parsing |
| `tool_output_limits.py` | ~150 | Output size limits |
| `tool_result_storage.py` | ~200 | Large result storage |
| `tool_backend_helpers.py` | ~200 | Backend utilities |
| `budget_config.py` | ~100 | Budget configuration |
| `binary_extensions.py` | ~50 | Binary file detection |
| `ansi_strip.py` | ~50 | ANSI escape stripping |
| `fuzzy_match.py` | ~100 | Fuzzy string matching |
| `debug_helpers.py` | ~100 | Debug utilities |
| `env_passthrough.py` | ~100 | Environment variable passing |
| `interrupt.py` | ~150 | Interrupt handling |
| `osv_check.py` | ~200 | OSV vulnerability checking |
| `slash_confirm.py` | ~100 | Slash command confirmation |

### External API Clients

| File | Lines | Purpose |
|------|-------|---------|
| `openrouter_client.py` | ~300 | OpenRouter API client |
| `xai_http.py` | ~200 | X.AI API client |
| `neutts_synth.py` | ~300 | NeuTTS synthesis |

---

## Execution Environments (`.hermes-ref/tools/environments/`)

| File | Lines | Purpose |
|------|-------|---------|
| `base.py` | 800 | Base environment interface |
| `local.py` | 450 | Local execution |
| `docker.py` | 650 | Docker containerized execution |
| `ssh.py` | 320 | SSH remote execution |
| `modal.py` | 430 | Modal serverless GPU |
| `managed_modal.py` | 260 | Managed Modal instances |
| `modal_utils.py` | 170 | Modal utilities |
| `daytona.py` | 250 | Daytona dev environments |
| `singularity.py` | 240 | Singularity HPC clusters |
| `vercel_sandbox.py` | 530 | Vercel serverless sandbox |
| `file_sync.py` | 430 | File synchronization across backends |

---

## Gateway (`.hermes-ref/gateway/`)

**Multi-platform messaging gateway**

### Core Gateway Files

| File | Lines | Size | Purpose |
|------|-------|------|---------|
| `run.py` | ~17,000 | 659KB | Main gateway, platform orchestration |
| `session.py` | ~1,400 | 56KB | Session management across platforms |
| `stream_consumer.py` | ~1,200 | 49KB | LLM stream consumption |
| `config.py` | ~1,900 | 73KB | Gateway configuration |
| `status.py` | ~700 | 27KB | Platform status tracking |
| `delivery.py` | ~220 | 9KB | Message delivery |
| `channel_directory.py` | ~340 | 13KB | Channel management |
| `pairing.py` | ~300 | 12KB | User pairing |
| `hooks.py` | ~200 | 8KB | Platform hooks |
| `platform_registry.py` | ~190 | 7KB | Platform registration |
| `mirror.py` | ~140 | 6KB | Message mirroring |
| `session_context.py` | ~150 | 6KB | Session context |
| `display_config.py` | ~180 | 7KB | Display configuration |
| `runtime_footer.py` | ~130 | 5KB | Runtime footer |
| `restart.py` | ~20 | 1KB | Restart handling |
| `sticker_cache.py` | ~80 | 3KB | Sticker caching |
| `whatsapp_identity.py` | ~160 | 6KB | WhatsApp identity |

### Platform Adapters (`.hermes-ref/gateway/platforms/`)

| File | Lines | Size | Platform |
|------|-------|------|----------|
| `base.py` | ~3,600 | 138KB | Base platform interface |
| `telegram.py` | ~4,100 | 158KB | Telegram |
| `discord.py` | ~4,900 | 190KB | Discord |
| `feishu.py` | ~5,100 | 198KB | Feishu/Lark |
| `yuanbao.py` | ~4,800 | 186KB | Yuanbao |
| `slack.py` | ~3,200 | 124KB | Slack |
| `api_server.py` | ~3,200 | 125KB | REST API Server |
| `matrix.py` | ~2,700 | 105KB | Matrix |
| `weixin.py` | ~2,100 | 80KB | WeChat |
| `wecom.py` | ~1,700 | 65KB | WeChat Work |
| `signal.py` | ~1,500 | 59KB | Signal |
| `dingtalk.py` | ~1,400 | 56KB | DingTalk |
| `feishu_comment.py` | ~1,300 | 51KB | Feishu Comments |
| `whatsapp.py` | ~1,200 | 47KB | WhatsApp |
| `bluebubbles.py` | ~900 | 35KB | BlueBubbles (iMessage) |
| `mattermost.py` | ~820 | 32KB | Mattermost |
| `webhook.py` | ~800 | 31KB | Webhook |
| `email.py` | ~700 | 27KB | Email |
| `yuanbao_sticker.py` | ~550 | 21KB | Yuanbao Stickers |
| `yuanbao_proto.py` | ~970 | 38KB | Yuanbao Protocol |
| `yuanbao_media.py` | ~530 | 21KB | Yuanbao Media |
| `sms.py` | ~370 | 14KB | SMS |
| `homeassistant.py` | ~420 | 16KB | Home Assistant |
| `feishu_comment_rules.py` | ~370 | 14KB | Feishu Comment Rules |
| `signal_rate_limit.py` | ~380 | 15KB | Signal Rate Limiting |
| `wecom_callback.py` | ~430 | 17KB | WeChat Work Callback |
| `wecom_crypto.py` | ~140 | 5KB | WeChat Work Crypto |
| `telegram_network.py` | ~240 | 9KB | Telegram Network |
| `helpers.py` | ~250 | 10KB | Platform Helpers |
| `_http_client_limits.py` | ~80 | 3KB | HTTP Client Limits |

**Guide:**
- `ADDING_A_PLATFORM.md` - 9KB guide for adding new platforms

---

## Cron Scheduler (`.hermes-ref/cron/`)

| File | Lines | Size | Purpose |
|------|-------|------|---------|
| `scheduler.py` | ~1,500 | 59KB | Tick-based job execution, file locking |
| `jobs.py` | ~950 | 37KB | Job definitions, storage, CRUD |
| `__init__.py` | ~30 | 1KB | Module init |

---

## Plugins (`.hermes-ref/plugins/`)

### Memory Providers (`.hermes-ref/plugins/memory/`)

| Provider | Files | Purpose |
|----------|-------|---------|
| `honcho/` | 3 files | Dialectic user modeling (agentskills.io) |
| `mem0/` | 3 files | Mem0 memory platform |
| `supermemory/` | 3 files | Supermemory vault |
| `holographic/` | 6 files | Embeddings-based memory |
| `hindsight/` | 3 files | Hindsight memory |
| `byterover/` | 3 files | ByteRover memory |
| `openviking/` | 3 files | OpenViking memory |
| `retaindb/` | 3 files | RetainDB memory |

**Core Memory Manager:** `plugins/memory/__init__.py` (14KB)

### Other Plugins

| Plugin | Purpose |
|--------|---------|
| `context_engine/` | Context management |
| `disk-cleanup/` | Disk cleanup automation |
| `example-dashboard/` | Dashboard example |
| `google_meet/` | Google Meet integration |
| `hermes-achievements/` | Achievement tracking |
| `image_gen/` | Image generation plugin |
| `kanban/` | Kanban board plugin |
| `observability/` | Observability/metrics |
| `platforms/` | Platform plugins |
| `spotify/` | Spotify integration |
| `strike-freedom-cockpit/` | Custom cockpit UI |

---

## Skills Directory (`.hermes-ref/skills/`)

**25 skill categories with 100+ skills total**

| Category | Path | Description |
|----------|------|-------------|
| `apple/` | `.hermes-ref/skills/apple/` | Apple ecosystem skills |
| `autonomous-ai-agents/` | `.hermes-ref/skills/autonomous-ai-agents/` | Agent development |
| `creative/` | `.hermes-ref/skills/creative/` | Creative writing, brainstorming |
| `data-science/` | `.hermes-ref/skills/data-science/` | Data analysis, ML |
| `devops/` | `.hermes-ref/skills/devops/` | CI/CD, infrastructure |
| `diagramming/` | `.hermes-ref/skills/diagramming/` | Diagram generation |
| `dogfood/` | `.hermes-ref/skills/dogfood/` | Internal testing |
| `domain/` | `.hermes-ref/skills/domain/` | Domain-specific skills |
| `email/` | `.hermes-ref/skills/email/` | Email management |
| `gaming/` | `.hermes-ref/skills/gaming/` | Gaming assistance |
| `gifs/` | `.hermes-ref/skills/gifs/` | GIF creation/search |
| `github/` | `.hermes-ref/skills/github/` | GitHub operations |
| `index-cache/` | `.hermes-ref/skills/index-cache/` | Skill indexing |
| `inference-sh/` | `.hermes-ref/skills/inference-sh/` | Inference.sh integration |
| `mcp/` | `.hermes-ref/skills/mcp/` | MCP server skills |
| `media/` | `.hermes-ref/skills/media/` | Media processing |
| `mlops/` | `.hermes-ref/skills/mlops/` | ML operations |
| `note-taking/` | `.hermes-ref/skills/note-taking/` | Note management |
| `productivity/` | `.hermes-ref/skills/productivity/` | Productivity tools |
| `red-teaming/` | `.hermes-ref/skills/red-teaming/` | Security testing |
| `research/` | `.hermes-ref/skills/research/` | Research assistance |
| `smart-home/` | `.hermes-ref/skills/smart-home/` | Smart home control |
| `social-media/` | `.hermes-ref/skills/social-media/` | Social media management |
| `software-development/` | `.hermes-ref/skills/software-development/` | Coding assistance |
| `yuanbao/` | `.hermes-ref/skills/yuanbao/` | Yuanbao-specific skills |

**Skill Format:** Each skill is a `SKILL.md` file with YAML frontmatter:
```yaml
---
name: skill-name
description: What this skill does
tags: [tag1, tag2]
platforms: [macos, linux, windows]
prerequisites:
  env_vars: [VAR1, VAR2]
  commands: [cmd1, cmd2]
related_skills: [other-skill]
---

# Skill content in Markdown
```

---

## Key Architectural Patterns

### 1. Lazy Import Optimization
**Location:** `run_agent.py` lines 45-90

```python
class _OpenAIProxy:
    """Lazy proxy - defers 240ms SDK load until first use"""
    def __call__(self, *args, **kwargs):
        from openai import OpenAI
        return OpenAI(*args, **kwargs)
    def __instancecheck__(self, instance):
        from openai import OpenAI
        return isinstance(instance, OpenAI)
```

### 2. Tool Registry Pattern
**Location:** `tools/registry.py`

- Singleton `ToolRegistry` class
- Thread-safe with RLock
- Generation counter for cache invalidation
- TTL-cached `check_fn` results (30s)
- Toolset grouping and aliases

### 3. Session Splitting
**Location:** `hermes_state.py`

- `parent_session_id` chains for context compression
- Maintains history reference without full context
- Triggered by token budget limits

### 4. Streaming Context Scrubber
**Location:** `plugins/memory/__init__.py`

- State machine for handling split memory-context tags across deltas
- Prevents leaking internal context in streamed responses

### 5. Platform Adapter Pattern
**Location:** `gateway/platforms/base.py`

- Base class with 138KB of shared functionality
- Each platform implements `send()`, `receive()`, `connect()`
- Unified media handling
- Rate limiting per platform

---

## Database Schema

**Location:** `hermes_state.py`

### Tables

```sql
-- Sessions
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT,
    model TEXT,
    config TEXT,  -- JSON
    system_prompt TEXT,
    source TEXT,  -- cli, telegram, discord, etc.
    created_at REAL,
    updated_at REAL
);

-- Messages
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    role TEXT,  -- system, user, assistant, tool
    content TEXT,
    tool_calls TEXT,  -- JSON
    tool_call_id TEXT,
    created_at REAL
);

-- FTS5 Full-text Search
CREATE VIRTUAL TABLE fts_messages USING fts5(
    content,
    content_rowid=id,
    tokenize='porter'
);

-- User Profiles
CREATE TABLE user_profiles (
    id TEXT PRIMARY KEY,
    platform TEXT,
    user_id TEXT,
    profile TEXT,  -- JSON
    created_at REAL,
    updated_at REAL
);
```

### Key Features
- WAL mode for concurrent access
- FTS5 with BM25 ranking
- Session chaining via `parent_session_id`
- Platform-aware user profiles

---

## Configuration System

**Location:** `gateway/config.py` (73KB)

### Config File Structure
```yaml
# ~/.hermes/config.yaml

# LLM Provider
model:
  provider: openrouter  # openai, anthropic, google, openrouter, ollama
  model: anthropic/claude-sonnet-4-20250514
  base_url: null
  api_key: null  # Use .env instead

# Agent Settings
agents:
  - id: default
    name: Default Agent
    model: {...}
    persona: "You are a helpful assistant..."
    tools: [terminal, read_file, write_file, web_search]
    mcp_servers: {}
    skills: []

# Server
server:
  port: 3210
  host: 127.0.0.1

# Behavior
behavior:
  max_steps: 10
  max_iterations: 90
  auto_approve: false
  stream: true

# Memory
memory:
  provider: builtin  # honcho, mem0, supermemory, etc.

# Gateway (messaging platforms)
gateway:
  telegram:
    token: ${TELEGRAM_BOT_TOKEN}
    allowed_users: []
  discord:
    token: ${DISCORD_BOT_TOKEN}
    guilds: []
  slack:
    token: ${SLACK_BOT_TOKEN}
    channels: []
  # ... 30+ more platforms

# Skills
skills:
  directory: skills
  auto_generate: false
  hub_sync: true

# Cron
cron:
  enabled: true
  timezone: UTC
```

### Environment Variables
**Location:** `~/.hermes/.env`

```bash
# LLM Providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
OPENROUTER_API_KEY=sk-or-...

# Messaging Platforms
TELEGRAM_BOT_TOKEN=...
DISCORD_BOT_TOKEN=...
SLACK_BOT_TOKEN=...

# Tools
BROWSERBASE_API_KEY=...
FIRECRAWL_API_KEY=...

# Memory Providers
HONCHO_API_KEY=...
MEM0_API_KEY=...
```

---

## CLI Commands Reference

**Location:** `cli.py` (~14,000 lines)

| Command | Description |
|---------|-------------|
| `/new` | Start new session |
| `/reset` | Reset current session |
| `/model [name]` | Switch LLM model |
| `/personality [text]` | Set agent persona |
| `/retry` | Retry last message |
| `/undo` | Undo last turn |
| `/compress` | Compress context |
| `/usage` | Show token usage |
| `/skills` | Browse skills |
| `/skill [name]` | Activate skill |
| `/platforms` | Gateway status |
| `/logs` | View logs |
| `/doctor` | Run diagnostics |
| `/kanban` | Show task board |
| `/tools` | List/toggle tools |
| `/memory` | Memory operations |
| `/goal [text]` | Set goal |
| `/focus [text]` | Set focus mode |
| `/export` | Export session |
| `/import` | Import session |
| `/config` | Edit config |
| `/env` | Edit environment |
| `/help` | Show help |
| And 25+ more... |

---

## File Size Summary

| Component | Total Size | Files |
|-----------|------------|-------|
| Core Python files | ~1.6MB | 15 |
| Tools | ~200KB | 74 |
| Gateway | ~2MB | 40 |
| Platforms | ~1.9MB | 35 |
| Plugins | ~100KB | 50 |
| Skills | ~500KB | 100+ |
| **Total** | **~6MB** | **300+** |

---

## What OpenAcme Needs to Implement

### Immediate (from tools/)
1. `tools/registry.py` pattern → Already have basic version
2. `tools/file_tools.py` → Add `patch` tool
3. `tools/web_tools.py` → Add `web_search`, `web_extract`
4. `tools/clarify_tool.py` → Add user clarification
5. `tools/memory_tool.py` → Add memory system
6. `tools/session_search_tool.py` → Add FTS5 search

### Medium-term (from tools/)
7. `tools/delegate_tool.py` → Subagent spawning
8. `tools/browser_tool.py` → Browser automation
9. `tools/vision_tools.py` → Image analysis
10. `tools/approval.py` → Safety guardrails

### Long-term (from gateway/)
11. `gateway/run.py` → Multi-platform gateway
12. `gateway/platforms/telegram.py` → Telegram adapter
13. `gateway/platforms/discord.py` → Discord adapter
14. `gateway/platforms/slack.py` → Slack adapter

### Infrastructure (from root)
15. `hermes_state.py` → Enhanced session store
16. `trajectory_compressor.py` → Context compression
17. `cron/scheduler.py` → Job scheduling
18. `plugins/memory/` → Memory provider system
