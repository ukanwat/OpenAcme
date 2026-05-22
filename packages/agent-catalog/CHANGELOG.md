# @openacme/agent-catalog

## 0.6.0

### Minor Changes

- @openacme/\* → 0.6.0

  Highlights since 0.5.3:
  - **Multimodal `read_file`** — images render inline in chat; screenshots from `browser_take_screenshot` flow through the same path.
  - **Browser overhaul** — pluggable providers (local Chrome, Browserbase, Browser-Use, Firecrawl), per-agent sessions, auto-provisioned Browserbase contexts, tool-result spill to attachments.
  - **Agent-scoped `session_search`** — full-text search now scoped to the caller's agent; no cross-agent leakage.
  - **Rename-swap compaction** — preflight + UX fixes; dead fork bookkeeping removed.
  - **Web design pass** — Cmd-K palette, workforce status, signal-blue meta, bounded search + FTS5 endpoint, agent filter polish.
  - **Auth picker** with provider-availability gating; upstream provider errors surfaced in chat UI.
  - **Software Engineer** agent template rebuilt with a real SWE persona.
  - Fixes: ChatGPT OAuth (two fixes), Browser-Use `/api/v2` profile auto-create, `context-1m` beta dropped on OAuth path, web behind reverse proxy.

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.6.0

## 0.5.3

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.5.0

## 0.4.0

### Minor Changes

- Release 0.4.0. First publish — synchronized with the rest of the workforce.
