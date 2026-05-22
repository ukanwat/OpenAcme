# @openacme/browser

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

## 0.5.3

## 0.5.2

### Patch Changes

- Pin `camoufox-js` to 0.9.3 (regular dep, no longer optional). camoufox-js@0.10.x bumped its `impit` dep to ^0.13.0, and impit@0.13.1+ ships a `preinstall: npx only-allow pnpm` hook that blocks every npm-based install. 0.9.3 → impit@^0.11.0 (no preinstall) and exposes the same `launchOptions` / `CamoufoxFetcher` / `installedVerStr` API our `binaries.ts` consumes. `npm install -g @openacme/cli` now produces a daemon with the Camoufox provider working out of the box.

## 0.5.1

### Patch Changes

- Make `camoufox-js` an optional dependency and whitelist native builds for pnpm 10+.

  Two install-blocking bugs in 0.5.0:
  1. **`camoufox-js → impit@0.13.1` carries `"preinstall": "npx only-allow pnpm"`**, which breaks every npm-based global install of `@openacme/cli`. Camoufox is one of several browser providers (chromium / browserbase / browser-use / firecrawl all work without it) and the browser code already lazy-imports `camoufox-js` with a try/catch (`packages/browser/src/binaries.ts`). Moved to `optionalDependencies` so failed installs don't fail the whole tree.
  2. **pnpm 10's strict build-script policy** silently skips native module builds, so `better-sqlite3` never compiles → `@openacme/db` crashes on import. Added `pnpm.onlyBuiltDependencies: ["better-sqlite3", "impit", "protobufjs"]` to `@openacme/cli`'s manifest so pnpm honors the build at install time without `pnpm approve-builds -g`.

  After this release, both `npm install -g @openacme/cli` and `pnpm add -g @openacme/cli` produce a working daemon.

## 0.5.0

## 0.4.0

### Minor Changes

- Release 0.4.0. First publish — synchronized with the rest of the workforce.
