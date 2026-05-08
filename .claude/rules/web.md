---
paths:
  - "apps/web/**"
---

# web

Next.js 16 App Router. Pages: `/` (chat), `/agents`, `/settings`, `/skills`. Tailwind + Radix primitives + react-markdown. Static-built into `packages/server/web/` and served by Hono.

## SSE event names are a 3-site contract

Names: `session | text-delta | tool-call | tool-result | error | done`. They match `StreamChunk.type` exactly.

- Flow: agent yields → `packages/server/src/app.ts:136` writes one SSE event per chunk → `app/page.tsx:274` (`dispatchSSE`) parses by `type`.
- Adding/renaming a chunk: edit all three (agent yield, server route, web parser). Forgetting any one drops the event silently — the UI will look "stuck" with no error.
- The CLI's headless path also reads StreamChunk; check it too.

## `skipNextHistoryLoadRef` prevents double-load on first message

`page.tsx:88`: a ref that, when true, suppresses the next history fetch. Set to `true` (`page.tsx:397`) right after sending the first message of a new session — the SSE has already announced the `sessionId` but the DB row was just created and there are no messages to load.

- Don't remove without replacing the guard. Without it, a 404-or-empty fetch races with the first SSE chunks and the UI flickers.

## `pnpm dev` does NOT update what Hono serves

`pnpm dev` runs Next.js dev server (port ~3000) and Hono dev server (3210) **side by side**. The static bundle in `packages/server/web/` is **not** updated.

- Only a full `pnpm build` rebuilds `apps/web/out/` and copies it into `packages/server/web/`.
- Implication: web changes show up at the Next dev port immediately, but the production-served path (Hono → static) only after a build.
- Don't try to stream HMR through Hono — the dev server is meant for that.

## No auth between web and server. Treat as 127.0.0.1 only.

There is **no** session, no token, no CSRF, no CORS gate (CORS is wide open). The deployment assumption is "trusted local environment."

- Do not add UI features that imply remote, multi-user, or shared-link semantics. Sharing a session id over the web means anyone on the network can read+write it.
- A session/token layer is a prerequisite for anything that crosses the local-only boundary. Until that exists, refuse the feature.

## Component layering

- `app/components/ui/` — shadcn-style primitives (button, card, input, select). Reuse before extending.
- `app/components/` — app-specific composites (Sidebar, Markdown, ToolBlock, MessageBubble).
- New banner / header / card: copy a sibling's font/gradient/border conventions before inventing. There's a feedback memory on this — drift looks bad and adds CSS debt.

## API client + base URL

`app/lib/api.ts` carries the API base URL (default `http://localhost:3210`). When the bundle is served from Hono itself, same-origin works; in dev (Next at :3000 → Hono at :3210), it's an absolute URL.

- Don't hardcode `http://localhost:3210` elsewhere. Threading the base URL through is the only way same-origin static and split-port dev both keep working.
