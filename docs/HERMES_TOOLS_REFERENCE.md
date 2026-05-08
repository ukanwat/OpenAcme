# Hermes Tools Reference

Complete list of all 69 tools in the Hermes reference implementation (`.hermes-ref/tools/`).

---

## File Operations (4 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `read_file` | file | Read file contents with line range support | `file_tools.py` |
| `write_file` | file | Write/create files | `file_tools.py` |
| `patch` | file | Apply unified diff patches to files | `file_tools.py` |
| `search_files` | file | Grep-based file content search with max results | `file_tools.py` |

---

## Terminal & Execution (3 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `terminal` | terminal | Execute shell commands across 6 backends (local, Docker, SSH, Modal, Daytona, Singularity) | `terminal_tool.py` |
| `execute_code` | code | Python REPL execution in isolated environment | `code_execution_tool.py` |
| `process` | process | Manage background processes (list, kill, status) | `process_registry.py` |

---

## Browser Automation (12 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `browser_navigate` | browser | Navigate to URL | `browser_tool.py` |
| `browser_snapshot` | browser | Capture page state (DOM/accessibility tree) | `browser_tool.py` |
| `browser_click` | browser | Click elements by selector or coordinates | `browser_tool.py` |
| `browser_type` | browser | Type text into input fields | `browser_tool.py` |
| `browser_scroll` | browser | Scroll page up/down/to element | `browser_tool.py` |
| `browser_back` | browser | Navigate back in history | `browser_tool.py` |
| `browser_press` | browser | Press keyboard keys (Enter, Tab, etc.) | `browser_tool.py` |
| `browser_get_images` | browser | Extract all images from page | `browser_tool.py` |
| `browser_vision` | browser | Visual analysis of current page | `browser_tool.py` |
| `browser_console` | browser | Execute JavaScript in browser console | `browser_tool.py` |
| `browser_cdp` | browser | Raw Chrome DevTools Protocol commands | `browser_cdp_tool.py` |
| `browser_dialog` | browser | Handle browser dialogs (alerts, confirms, prompts) | `browser_dialog_tool.py` |

**Browser Providers:**
- Local Playwright
- Browserbase (cloud)
- Firecrawl
- Browser-use

---

## Web Tools (2 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `web_search` | web | Search the web (multiple search providers) | `web_tools.py` |
| `web_extract` | web | Extract/scrape content from URLs, convert to markdown | `web_tools.py` |

---

## Vision & Media (3 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `vision_analyze` | vision | Analyze images with vision models (GPT-4V, Claude, etc.) | `vision_tools.py` |
| `image_generate` | image | Generate images (DALL-E, Midjourney, Flux, Stable Diffusion) | `image_generation_tool.py` |
| `text_to_speech` | tts | Convert text to speech with multiple voice models | `tts_tool.py` |

---

## Skills Management (3 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `skills_list` | skills | List/search available skills with FTS5 | `skills_tool.py` |
| `skill_view` | skills | View full skill content and metadata | `skills_tool.py` |
| `skill_manage` | skills | Create, update, delete, import skills | `skill_manager_tool.py` |

---

## Memory & Sessions (2 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `memory` | memory | Read/write agent memory (SOUL.md, MEMORY.md, USER.md) | `memory_tool.py` |
| `session_search` | session | Search conversation history with FTS5 full-text search | `session_search_tool.py` |

---

## Task Management (8 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `todo` | todo | Manage personal TODO items | `todo_tool.py` |
| `kanban_show` | kanban | Display kanban board with all tasks | `kanban_tools.py` |
| `kanban_create` | kanban | Create new task on board | `kanban_tools.py` |
| `kanban_complete` | kanban | Mark task as complete | `kanban_tools.py` |
| `kanban_block` | kanban | Block/unblock task with reason | `kanban_tools.py` |
| `kanban_heartbeat` | kanban | Update task progress/status | `kanban_tools.py` |
| `kanban_comment` | kanban | Add comment to task | `kanban_tools.py` |
| `kanban_link` | kanban | Link related tasks together | `kanban_tools.py` |

---

## Scheduling (1 tool)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `cronjob` | cron | Create/manage scheduled jobs with timezone support | `cronjob_tools.py` |

---

## Agent Delegation (2 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `delegate_task` | delegate | Spawn subagent for parallel workstreams, async execution | `delegate_tool.py` |
| `mixture_of_agents` | moa | Route tasks to specialized agents based on capability | `mixture_of_agents_tool.py` |

---

## Communication (1 tool)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `send_message` | messaging | Send messages across 35+ platforms (Telegram, Discord, Slack, WhatsApp, etc.) | `send_message_tool.py` |

---

## Discord Integration (2 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `discord` | discord | Discord channel operations (read, send, react) | `discord_tool.py` |
| `discord_admin` | discord | Discord admin operations (roles, moderation, server management) | `discord_tool.py` |

---

## Feishu/Lark Integration (5 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `feishu_doc_read` | feishu | Read Feishu/Lark documents | `feishu_doc_tool.py` |
| `feishu_drive_list_comments` | feishu | List comments on documents | `feishu_drive_tool.py` |
| `feishu_drive_list_comment_replies` | feishu | List replies to comments | `feishu_drive_tool.py` |
| `feishu_drive_reply_comment` | feishu | Reply to a comment | `feishu_drive_tool.py` |
| `feishu_drive_add_comment` | feishu | Add new comment to document | `feishu_drive_tool.py` |

---

## Yuanbao Integration (5 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `yb_query_group_info` | yuanbao | Query group information | `yuanbao_tools.py` |
| `yb_query_group_members` | yuanbao | List group members | `yuanbao_tools.py` |
| `yb_send_dm` | yuanbao | Send direct message | `yuanbao_tools.py` |
| `yb_search_sticker` | yuanbao | Search for stickers | `yuanbao_tools.py` |
| `yb_send_sticker` | yuanbao | Send sticker in chat | `yuanbao_tools.py` |

---

## Home Assistant Integration (4 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `ha_list_entities` | homeassistant | List all smart home entities | `homeassistant_tool.py` |
| `ha_get_state` | homeassistant | Get current state of entity | `homeassistant_tool.py` |
| `ha_list_services` | homeassistant | List available services | `homeassistant_tool.py` |
| `ha_call_service` | homeassistant | Call service (turn on lights, set temperature, etc.) | `homeassistant_tool.py` |

---

## RL Training (10 tools)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `rl_list_environments` | rl | List available RL training environments | `rl_training_tool.py` |
| `rl_select_environment` | rl | Select environment for training | `rl_training_tool.py` |
| `rl_get_current_config` | rl | Get current training configuration | `rl_training_tool.py` |
| `rl_edit_config` | rl | Edit training configuration | `rl_training_tool.py` |
| `rl_start_training` | rl | Start RL training run | `rl_training_tool.py` |
| `rl_check_status` | rl | Check training status | `rl_training_tool.py` |
| `rl_stop_training` | rl | Stop running training | `rl_training_tool.py` |
| `rl_get_results` | rl | Get training results and metrics | `rl_training_tool.py` |
| `rl_list_runs` | rl | List past training runs | `rl_training_tool.py` |
| `rl_test_inference` | rl | Quick inference test before training | `rl_training_tool.py` |

---

## Utility (1 tool)

| Tool | Toolset | Description | File |
|------|---------|-------------|------|
| `clarify` | utility | Ask user for clarification when instructions are ambiguous | `clarify_tool.py` |

---

## MCP Dynamic Tools

MCP (Model Context Protocol) tools are discovered dynamically at runtime from connected MCP servers.

| Component | Description | File |
|-----------|-------------|------|
| `mcp_tool.py` | Dynamic tool discovery and registration | `mcp_tool.py` |
| `mcp_oauth.py` | OAuth integration for MCP servers | `mcp_oauth.py` |
| `mcp_oauth_manager.py` | OAuth token management | `mcp_oauth_manager.py` |

**Features:**
- Automatic tool extraction from MCP servers
- HTTP, stdio, and custom transports
- Per-server timeout configuration
- Credential filtering for security
- Sampling support

---

## Supporting Infrastructure

### Tool Registry (`registry.py`)
- Central registration for all tools
- Schema validation
- Handler dispatch
- Availability checking (check_fn)
- Toolset grouping
- Generation counter for cache invalidation

### Safety & Security
| File | Purpose |
|------|---------|
| `approval.py` | Command approval workflows |
| `path_security.py` | File path validation |
| `url_safety.py` | URL validation |
| `tirith_security.py` | Security policies |
| `credential_files.py` | Credential detection |

### Execution Backends (`environments/`)
| Backend | File | Description |
|---------|------|-------------|
| Local | `local.py` | Direct execution on host |
| Docker | `docker.py` | Containerized execution |
| SSH | `ssh.py` | Remote machine execution |
| Modal | `modal.py` | Serverless GPU cloud |
| Daytona | `daytona.py` | Managed dev environments |
| Singularity | `singularity.py` | HPC clusters |
| Vercel | `vercel_sandbox.py` | Serverless sandbox |

### Browser Providers (`browser_providers/`)
| Provider | File |
|----------|------|
| Base | `base.py` |
| Browserbase | `browserbase.py` |
| Firecrawl | `firecrawl.py` |
| Browser-use | `browser_use.py` |

---

## Tool Counts by Category

| Category | Count |
|----------|-------|
| Browser Automation | 12 |
| RL Training | 10 |
| Task Management | 8 |
| Feishu Integration | 5 |
| Yuanbao Integration | 5 |
| File Operations | 4 |
| Home Assistant | 4 |
| Terminal & Execution | 3 |
| Vision & Media | 3 |
| Skills Management | 3 |
| Web Tools | 2 |
| Memory & Sessions | 2 |
| Agent Delegation | 2 |
| Discord Integration | 2 |
| Scheduling | 1 |
| Communication | 1 |
| Utility | 1 |
| **Total** | **69** |
