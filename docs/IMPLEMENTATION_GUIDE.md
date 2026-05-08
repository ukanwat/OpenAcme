# Implementation Guide

Detailed guide for implementing missing features with specific Hermes code references.

---

## 1. Patch Tool (Unified Diff)

**Priority:** P0 - Critical for code editing

**Hermes Reference:** `.hermes-ref/tools/file_tools.py` lines 400-600

### What It Does
Applies unified diff patches to files. Essential for making targeted edits without rewriting entire files.

### Key Functions to Study
```python
# .hermes-ref/tools/file_tools.py
def _handle_patch(args, **kwargs):
    """Apply unified diff patch to file"""
    # Parses unified diff format
    # Validates line numbers match
    # Applies hunks sequentially
    # Returns success/failure with context
```

### Schema
```json
{
  "name": "patch",
  "description": "Apply a unified diff patch to a file",
  "parameters": {
    "type": "object",
    "properties": {
      "file_path": {"type": "string", "description": "Path to file to patch"},
      "patch": {"type": "string", "description": "Unified diff patch content"}
    },
    "required": ["file_path", "patch"]
  }
}
```

### Also See
- `.hermes-ref/tools/patch_parser.py` - Diff parsing utilities

---

## 2. Web Search Tool

**Priority:** P0 - Critical for information retrieval

**Hermes Reference:** `.hermes-ref/tools/web_tools.py` lines 1-500

### What It Does
Searches the web using multiple providers (Google, Bing, DuckDuckGo, Brave, Serper).

### Key Functions
```python
# .hermes-ref/tools/web_tools.py
async def _handle_web_search(args, **kwargs):
    """Search web with provider fallback"""
    query = args.get("query")
    provider = args.get("provider", "auto")
    max_results = args.get("max_results", 10)

    # Provider selection logic
    # Rate limiting
    # Result normalization
    # Snippet extraction
```

### Schema
```json
{
  "name": "web_search",
  "description": "Search the web for information",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {"type": "string", "description": "Search query"},
      "max_results": {"type": "integer", "default": 10},
      "provider": {"type": "string", "enum": ["auto", "google", "bing", "duckduckgo"]}
    },
    "required": ["query"]
  }
}
```

### Environment Variables Needed
```bash
SERPER_API_KEY=...      # For Serper (Google)
BING_API_KEY=...        # For Bing
BRAVE_API_KEY=...       # For Brave Search
```

---

## 3. Web Extract Tool

**Priority:** P0 - Critical for reading web content

**Hermes Reference:** `.hermes-ref/tools/web_tools.py` lines 500-1000

### What It Does
Extracts and converts web page content to clean markdown.

### Key Functions
```python
# .hermes-ref/tools/web_tools.py
async def _handle_web_extract(args, **kwargs):
    """Extract content from URL"""
    url = args.get("url")

    # URL validation
    # robots.txt checking
    # HTML fetching with timeout
    # Content extraction (readability algorithm)
    # Markdown conversion
    # Size limiting
```

### Schema
```json
{
  "name": "web_extract",
  "description": "Extract content from a web page as markdown",
  "parameters": {
    "type": "object",
    "properties": {
      "url": {"type": "string", "description": "URL to extract content from"},
      "include_links": {"type": "boolean", "default": true},
      "include_images": {"type": "boolean", "default": false}
    },
    "required": ["url"]
  }
}
```

### Also See
- `.hermes-ref/tools/url_safety.py` - URL validation
- `.hermes-ref/tools/website_policy.py` - Access policies

---

## 4. Clarify Tool

**Priority:** P0 - Essential for user interaction

**Hermes Reference:** `.hermes-ref/tools/clarify_tool.py`

### What It Does
Allows agent to ask user for clarification when instructions are ambiguous.

### Key Functions
```python
# .hermes-ref/tools/clarify_tool.py
def _handle_clarify(args, **kwargs):
    """Ask user for clarification"""
    question = args.get("question")
    options = args.get("options", [])

    # Formats question for user
    # Handles multiple choice if options provided
    # Returns user response
```

### Schema
```json
{
  "name": "clarify",
  "description": "Ask the user for clarification",
  "parameters": {
    "type": "object",
    "properties": {
      "question": {"type": "string", "description": "Question to ask the user"},
      "options": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Optional multiple choice options"
      }
    },
    "required": ["question"]
  }
}
```

---

## 5. Memory Tool

**Priority:** P0 - Critical for persistent context

**Hermes Reference:** `.hermes-ref/tools/memory_tool.py`

### What It Does
Read/write to persistent memory files (SOUL.md, MEMORY.md, USER.md).

### Memory File Structure
```
~/.openacme/memory/
├── SOUL.md      # Agent identity, personality, values
├── MEMORY.md    # Learned facts, procedures
└── USER.md      # User preferences, context
```

### Key Functions
```python
# .hermes-ref/tools/memory_tool.py
def _handle_memory(args, **kwargs):
    """Memory operations"""
    action = args.get("action")  # read, write, append
    file = args.get("file")      # soul, memory, user
    content = args.get("content")

    # File path resolution
    # Content validation
    # Atomic writes
    # Change tracking
```

### Schema
```json
{
  "name": "memory",
  "description": "Read or write to persistent memory",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {"type": "string", "enum": ["read", "write", "append"]},
      "file": {"type": "string", "enum": ["soul", "memory", "user"]},
      "content": {"type": "string", "description": "Content to write (for write/append)"}
    },
    "required": ["action", "file"]
  }
}
```

### Also See
- `.hermes-ref/plugins/memory/__init__.py` - Memory manager (14KB)
- `.hermes-ref/plugins/memory/honcho/` - Honcho provider example

---

## 6. Session Search Tool

**Priority:** P1 - Important for context retrieval

**Hermes Reference:** `.hermes-ref/tools/session_search_tool.py`

### What It Does
Full-text search across conversation history using FTS5.

### Database Setup
```sql
-- Add to existing schema
CREATE VIRTUAL TABLE fts_messages USING fts5(
    content,
    content_rowid=id,
    tokenize='porter'
);

-- Trigger to keep FTS in sync
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO fts_messages(rowid, content) VALUES (new.rowid, new.content);
END;
```

### Key Functions
```python
# .hermes-ref/tools/session_search_tool.py
def _handle_session_search(args, **kwargs):
    """Search conversation history"""
    query = args.get("query")
    limit = args.get("limit", 20)
    session_id = args.get("session_id")  # Optional: limit to session

    # FTS5 query with BM25 ranking
    # Snippet extraction
    # Session metadata inclusion
```

### Schema
```json
{
  "name": "session_search",
  "description": "Search conversation history",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {"type": "string", "description": "Search query"},
      "limit": {"type": "integer", "default": 20},
      "session_id": {"type": "string", "description": "Optional: limit to specific session"}
    },
    "required": ["query"]
  }
}
```

### Also See
- `.hermes-ref/hermes_state.py` lines 500-800 - FTS5 implementation

---

## 7. Delegate Task Tool

**Priority:** P1 - Important for complex tasks

**Hermes Reference:** `.hermes-ref/tools/delegate_tool.py` (2,531 lines)

### What It Does
Spawns a subagent to handle a task in parallel.

### Key Concepts
1. **Subagent Creation** - New agent instance with isolated context
2. **Task Handoff** - Pass task description and relevant context
3. **Result Collection** - Async result retrieval
4. **Resource Limits** - Token/time budgets

### Key Functions
```python
# .hermes-ref/tools/delegate_tool.py
async def _handle_delegate_task(args, **kwargs):
    """Delegate task to subagent"""
    task = args.get("task")
    context = args.get("context", "")
    tools = args.get("tools", [])  # Tools available to subagent
    max_steps = args.get("max_steps", 10)

    # Create subagent with limited toolset
    # Pass task and context
    # Run asynchronously
    # Return result when complete
```

### Schema
```json
{
  "name": "delegate_task",
  "description": "Delegate a task to a subagent",
  "parameters": {
    "type": "object",
    "properties": {
      "task": {"type": "string", "description": "Task description"},
      "context": {"type": "string", "description": "Relevant context"},
      "tools": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Tools available to subagent"
      },
      "max_steps": {"type": "integer", "default": 10}
    },
    "required": ["task"]
  }
}
```

---

## 8. Tool Guardrails (Approval System)

**Priority:** P1 - Important for safety

**Hermes Reference:** `.hermes-ref/tools/approval.py` (1,245 lines)

### What It Does
Requires user approval for dangerous operations.

### Key Concepts
1. **Command Classification** - Safe vs dangerous
2. **Allowlist/Blocklist** - Per-user rules
3. **Approval Flow** - Request → User decision → Execute/Reject
4. **Audit Logging** - Track all approvals

### Dangerous Patterns
```python
# .hermes-ref/tools/approval.py
DANGEROUS_PATTERNS = [
    r"rm\s+-rf",
    r"sudo\s+",
    r"chmod\s+777",
    r">\s*/dev/",
    r"mkfs\.",
    r"dd\s+if=",
    # ... more patterns
]
```

### Key Functions
```python
# .hermes-ref/tools/approval.py
def check_command_safety(command: str) -> tuple[bool, str]:
    """Check if command is safe to execute"""
    # Pattern matching
    # Path analysis
    # Return (is_safe, reason)

async def request_approval(command: str, context: str) -> bool:
    """Request user approval for dangerous command"""
    # Format approval request
    # Wait for user response
    # Log decision
```

---

## 9. Context Compression

**Priority:** P2 - Important for long conversations

**Hermes Reference:** `.hermes-ref/trajectory_compressor.py` (1,600 lines)

### What It Does
Compresses conversation history to fit token budget.

### Key Concepts
1. **Token Counting** - Accurate per-model counting
2. **Message Summarization** - LLM-based compression
3. **Session Splitting** - Create parent session reference
4. **Priority Preservation** - Keep recent and important messages

### Key Functions
```python
# .hermes-ref/trajectory_compressor.py
async def compress_trajectory(
    messages: list,
    token_budget: int,
    model: str
) -> list:
    """Compress messages to fit budget"""
    # Count current tokens
    # If over budget:
    #   1. Summarize old messages
    #   2. Remove tool call details
    #   3. Split to parent session if needed
    # Return compressed messages
```

### Also See
- `.hermes-ref/hermes_state.py` - Session splitting with `parent_session_id`

---

## 10. Browser Automation

**Priority:** P2 - Advanced feature

**Hermes Reference:** `.hermes-ref/tools/browser_tool.py` (2,991 lines)

### What It Does
Full browser automation via Playwright/CDP.

### Tools to Implement
1. `browser_navigate` - Go to URL
2. `browser_snapshot` - Get page state
3. `browser_click` - Click element
4. `browser_type` - Type text
5. `browser_scroll` - Scroll page
6. `browser_back` - Go back
7. `browser_press` - Press key
8. `browser_get_images` - Extract images
9. `browser_vision` - Visual analysis
10. `browser_console` - Execute JS

### Key Dependencies
```json
{
  "playwright": "^1.40.0",
  "@anthropic-ai/sdk": "^0.20.0"  // For vision
}
```

### Also See
- `.hermes-ref/tools/browser_supervisor.py` - Browser lifecycle
- `.hermes-ref/tools/browser_providers/` - Provider abstraction

---

## 11. Messaging Gateway

**Priority:** P3 - Platform integrations

**Hermes Reference:** `.hermes-ref/gateway/run.py` (17,000 lines)

### Architecture Overview
```
Gateway
├── Platform Registry
│   ├── Telegram Adapter
│   ├── Discord Adapter
│   ├── Slack Adapter
│   └── ...
├── Session Router
│   └── Routes messages to correct agent/session
├── Stream Consumer
│   └── Handles LLM streaming to platforms
└── Delivery Manager
    └── Ensures message delivery
```

### Key Components to Study
1. `gateway/platforms/base.py` - Base adapter (138KB)
2. `gateway/platforms/telegram.py` - Telegram example (158KB)
3. `gateway/session.py` - Session routing (56KB)
4. `gateway/stream_consumer.py` - Stream handling (49KB)

### Platform Adapter Interface
```python
# .hermes-ref/gateway/platforms/base.py
class PlatformAdapter:
    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def send_message(self, chat_id: str, text: str) -> None: ...
    async def send_media(self, chat_id: str, media: bytes, type: str) -> None: ...
    async def on_message(self, callback: Callable) -> None: ...
```

---

## 12. Cron Scheduler

**Priority:** P3 - Automation feature

**Hermes Reference:** `.hermes-ref/cron/scheduler.py` (1,500 lines)

### What It Does
Executes scheduled jobs with timezone support.

### Key Components
```python
# .hermes-ref/cron/scheduler.py
class Scheduler:
    def __init__(self):
        self.jobs: Dict[str, Job] = {}
        self.lock = FileLock("~/.hermes/cron.lock")

    async def tick(self):
        """Called every minute"""
        now = datetime.now(self.timezone)
        for job in self.jobs.values():
            if job.should_run(now):
                await self.execute_job(job)

    async def execute_job(self, job: Job):
        """Execute job with agent"""
        # Create agent session
        # Run job task
        # Deliver result to configured platform
```

### Job Definition
```python
# .hermes-ref/cron/jobs.py
@dataclass
class Job:
    id: str
    name: str
    schedule: str  # Cron expression
    task: str      # Task description
    agent_id: str
    tools: List[str]
    delivery: Dict[str, str]  # platform -> channel
    timezone: str
    enabled: bool
```

### Also See
- `.hermes-ref/cron/jobs.py` - Job CRUD operations

---

## Summary: Implementation Order

### Week 1-2: Core Tools
- [ ] `patch` tool
- [ ] `web_search` tool
- [ ] `web_extract` tool
- [ ] `clarify` tool

### Week 3-4: Memory & Search
- [ ] `memory` tool
- [ ] FTS5 setup
- [ ] `session_search` tool

### Week 5-6: Safety & Delegation
- [ ] Tool guardrails
- [ ] `delegate_task` tool
- [ ] Context compression

### Week 7-8: Advanced
- [ ] Browser automation (basic)
- [ ] Vision tools
- [ ] CLI enhancements

### Week 9+: Gateway
- [ ] Gateway architecture
- [ ] Telegram adapter
- [ ] Discord adapter
