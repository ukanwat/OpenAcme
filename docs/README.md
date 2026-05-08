# OpenAcme Documentation

Reference documentation for the OpenAcme AI Agent Platform.

## Documents

| Document | Description |
|----------|-------------|
| [MISSING_FEATURES.md](./MISSING_FEATURES.md) | Gap analysis - what needs to be built |
| [HERMES_TOOLS_REFERENCE.md](./HERMES_TOOLS_REFERENCE.md) | Complete list of 69 Hermes tools |
| [HERMES_ARCHITECTURE_DEEP_DIVE.md](./HERMES_ARCHITECTURE_DEEP_DIVE.md) | Detailed architecture with file paths and line counts |

## Quick Reference

### Current State (OpenAcme)
- **Tools:** 5 (shell, read_file, write_file, list_files, search_files)
- **Platforms:** 0
- **Memory Providers:** 0
- **Skills:** 0
- **CLI Commands:** ~5

### Target State (Hermes Parity)
- **Tools:** 69
- **Platforms:** 35+
- **Memory Providers:** 8
- **Skills:** 100+ across 25 categories
- **CLI Commands:** 50+

## Key Reference Locations

### Hermes Reference (`.hermes-ref/`)

```
.hermes-ref/
├── run_agent.py          # Main agent (722KB, ~18K lines)
├── cli.py                # CLI interface (545KB, ~14K lines)
├── hermes_state.py       # SQLite + FTS5 (96KB)
├── model_tools.py        # Tool dispatch (35KB)
├── tools/                # 69 tools (53K lines total)
│   ├── registry.py       # Tool registry
│   ├── file_tools.py     # File operations
│   ├── terminal_tool.py  # Shell execution
│   ├── browser_tool.py   # Browser automation
│   ├── web_tools.py      # Web search/extract
│   ├── delegate_tool.py  # Subagent spawning
│   ├── mcp_tool.py       # MCP integration
│   └── ...
├── gateway/              # Messaging gateway (2MB)
│   ├── run.py            # Gateway orchestration
│   ├── platforms/        # 35+ platform adapters
│   │   ├── telegram.py
│   │   ├── discord.py
│   │   ├── slack.py
│   │   └── ...
│   └── ...
├── cron/                 # Job scheduler
│   ├── scheduler.py
│   └── jobs.py
├── plugins/              # Plugin system
│   └── memory/           # 8 memory providers
├── skills/               # 25 skill categories
└── ...
```

## Implementation Priority

### Phase 1: Core Tools
1. `patch` - Unified diff (see `.hermes-ref/tools/file_tools.py`)
2. `web_search` - Web search (see `.hermes-ref/tools/web_tools.py`)
3. `web_extract` - Web scraping (see `.hermes-ref/tools/web_tools.py`)
4. `clarify` - User clarification (see `.hermes-ref/tools/clarify_tool.py`)
5. `memory` - Agent memory (see `.hermes-ref/tools/memory_tool.py`)

### Phase 2: Infrastructure
6. FTS5 search (see `.hermes-ref/hermes_state.py`)
7. Context compression (see `.hermes-ref/trajectory_compressor.py`)
8. Tool guardrails (see `.hermes-ref/tools/approval.py`)

### Phase 3: Advanced Tools
9. `delegate_task` - Subagents (see `.hermes-ref/tools/delegate_tool.py`)
10. Browser automation (see `.hermes-ref/tools/browser_tool.py`)
11. Vision tools (see `.hermes-ref/tools/vision_tools.py`)

### Phase 4: Gateway
12. Gateway architecture (see `.hermes-ref/gateway/run.py`)
13. Platform adapters (see `.hermes-ref/gateway/platforms/`)
