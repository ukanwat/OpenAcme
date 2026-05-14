---
paths:
  - "apps/web/**"
---

# web

Next.js 16 App Router. Pages: `/` (chat), `/agents`, `/settings`, `/skills`. Tailwind + Radix primitives + react-markdown. Static-built into `packages/server/web/` and served by Hono.

## Chat is SSE-only. The page owns `messages` state directly.

`apps/web/app/page.tsx` does NOT use `useChat`. Agent runs are server-owned; every observer (the originating tab included) reads them over the per-session SSE channel via `useLiveSession`. `messages` is plain `useState<OpenAcmeUIMessage[]>` — that's the canonical render source.

The send flow:

1. `crypto.randomUUID()` mints a sessionId when there's no active one. The client owns it; the server creates the row from whatever is passed.
2. Set `activeSessionId(sid)` → `useLiveSession` effect opens the EventSource → `liveConnectedRef.current` flips to true on `onopen`.
3. `await waitForCondition(() => liveConnectedRef.current, 2000)` so the agent's first chunks can't be missed.
4. Optimistic `setMessages(prev => [...prev, userMsg])` with a client-generated user-message id; the server uses that id when it persists + echoes, so the SSE `messages_appended` upserts in place.
5. `POST /api/chat` with `{agentId, sessionId, messages: historyForServer}`. Returns JSON `{sessionId, userMessageId, assistantMessageId}` — no response body to read.
6. Everything else (chunks, status, final message) arrives via SSE.

- Don't reintroduce `useChat`. The same-tab + cross-tab observer paths are now one code path; reintroducing the HTTP-response reader reintroduces the same-id coordination dance (`responseMessageId`, `suppressPartAssembly`) the SSE-only refactor removed.
- `freshSessionIdRef` flags client-generated sessions so the history + metadata fetches skip them — the server row doesn't exist until /api/chat lands.
- The running→idle effect refetches `/messages` to pick up server-side sanitization + the recall part attached to the user message. Don't drop that refetch.

## Stop button → `DELETE /api/sessions/:id/active-turn`

The HTTP request that started the turn already returned; the agent run lives in the server's `activeTurns` map. Stop calls the DELETE endpoint. Idempotent.

## Custom data parts arrive via `useLiveSession({onDataPart})`

Transient parts (e.g. `data-status`) are stripped by `readUIMessageStream` so they never land in `messages`. `useLiveSession` peeks at raw `ui_message_part` chunks and surfaces `data-*` parts through `onDataPart` for the page to handle (e.g. the `statusBoard`). Non-transient data parts land in `messages` as ordinary parts.

## Attachments: pending → committed flow

1. User picks/drops files (textarea container has `onDragOver/Drop` gated on `dataTransfer.types.includes("Files")` AND `acceptsAttachments`).
2. `uploadFiles(files)` POSTs multipart to `/api/uploads`. Server returns `{pendingId, url: "/api/attachments/__pending__/<id>/<file>", kind, mediaType, size, filename}` per file.
3. Web stages chips with the pending URL + a local `URL.createObjectURL(file)` preview for image MIME types.
4. On send: include `{type:"file", url: pendingUrl, mediaType, filename}` in the optimistic user message's `parts`. The pending URL travels into `historyForServer` and the POST body.
5. Server's `/api/chat` validates pendings, moves files to `<sessionId>/<attId>/<file>`, rewrites URLs in the user message it persists, and echoes the rewritten version via `messages_appended` (same id) — the SSE handler upserts in place.

- Provider-gate the picker via `activeModalities` from `/api/models` (each preset carries `inputModalities` from the bundled registry). Disable picker + drag-drop overlay when the active model is text-only.
- Per-file blob preview URL — `URL.revokeObjectURL` after send to avoid leaking object URLs.

## One URL: `:3210` in dev and published. Hono fronts the UI; in dev it proxies to Next.

`pnpm dev` runs Hono on the configured `server.port` (default `:3210`) and Next dev on `server.port + 10` (default `:3220`, loopback only). Hono routes `/api/*` in-process and proxies everything else — including `_next/*` HMR WebSocket upgrades — to Next. Open the API port. The proxy seam lives in `packages/server/src/dev-proxy.ts`; both dev scripts (`packages/server/scripts/dev.mjs`, `apps/web/scripts/dev.mjs`) share `scripts/lib/dev-ports.mjs`, which reads `server.port` from `<dataDir>/config.yaml` and derives the web port. Two parallel `pnpm dev` sessions against different data dirs work automatically as long as their API ports differ — single config knob (`server.port`), no env vars.

- Don't reintroduce `next.config.js` rewrites for `/api/*`. Same-origin already works — the browser only sees `:3210`.
- Don't open `:3220` in docs / browser-launch / status output. It's an internal port; `:3210` is the canonical URL.
- The Next dev port is loopback-bound but technically reachable on the box. Treat it like the rest of the local-only attack surface (no auth between web ↔ server today).
- Published installs: Hono on `:3210` serves the static export at `packages/server/web/` (filled by `prepack`). No proxy, no Next process. Same URL.
- Daemons running outside the dev proxy (e.g. `pnpm agent start --data-dir ~/.openacme-test`) skip Next entirely. They serve the bundled static if present, else fall back to the workspace `apps/web/out` (after a local `pnpm build`). API-only if neither exists. Two daemons can run at once because the test slot doesn't need `:3220`.

## No auth between web and server. Treat as 127.0.0.1 only.

There is **no** session, no token, no CSRF, no CORS gate (CORS is wide open). The deployment assumption is "trusted local environment."

- Do not add UI features that imply remote, multi-user, or shared-link semantics. Sharing a session id over the web means anyone on the network can read+write it.
- A session/token layer is a prerequisite for anything that crosses the local-only boundary. Until that exists, refuse the feature.
- The secret-cookie auth middleware on the server side exists for non-loopback daemon deployments, not for in-app auth.

## Component layering

- `app/components/ui/` — shadcn-style primitives (button, card, input, select). Reuse before extending.
- `app/components/` — app-specific composites (Sidebar, Markdown, AttachmentChip, MessageBubble lives inline in `page.tsx`).
- New banner / header / card: copy a sibling's font/gradient/border conventions before inventing. There's a feedback memory on this — drift looks bad and adds CSS debt.

## Rendering UIMessage parts

`MessageBubble` (in `page.tsx`) renders parts in order:

- `type === "text"` → `<Markdown>{text}</Markdown>`. The streaming cursor (animated bar) goes after the LAST text part.
- `type === "file"` → `<img>` for `mediaType.startsWith("image/")`, `AttachmentChip` (link) otherwise.
- `type.startsWith("tool-")` → collapsible block showing the tool name, the part's `state` (`input-streaming` | `input-available` | `output-available` | `output-error`), `input` JSON, and `output`/`errorText`.
- `reasoning`, `source-*`, `data-*` (non-transient) — silently ignored in v1.

## API client + base URL

`app/lib/api.ts` carries `API_BASE` (default `""` for same-origin). The browser only ever talks to `:3210` (Hono fronts the UI in dev via proxy and serves the bundled static in published), so same-origin always works — no `next.config.js` rewrites and no hardcoded host.

- Don't hardcode `http://localhost:3210` elsewhere. Threading `API_BASE` through is the only way same-origin static and split-port dev both keep working.
