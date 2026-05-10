---
paths:
  - "apps/web/**"
---

# web

Next.js 16 App Router. Pages: `/` (chat), `/agents`, `/settings`, `/skills`. Tailwind + Radix primitives + react-markdown. Static-built into `packages/server/web/` and served by Hono.

## `useChat` + `DefaultChatTransport` is the chat contract

`apps/web/app/page.tsx` uses `@ai-sdk/react`'s `useChat` with a `DefaultChatTransport({ api, prepareSendMessagesRequest })`. The transport callback injects `agentId` + `sessionId` into the body each send so the server route can resolve the right agent. Streaming is the SDK's UIMessageStream protocol — the SDK parses; we don't.

- `messages` from `useChat` IS the canonical render source. Do not maintain a parallel state.
- `sendMessage({ role: "user", parts: [...] })` is the canonical send shape. Files are `{type:"file", url, mediaType, filename}` — `url` is the pending `/api/attachments/__pending__/<id>/<filename>` until the chat handler commits it.
- `setMessages(history)` repopulates after a session switch (history fetched from `/api/sessions/:id/messages`).
- `status` is `"submitted" | "streaming" | "ready" | "error"`. The send button + textarea disable on the first two.

## Session-id pinning via `data-session` transient part

Server emits `{type: "data-session", data: {sessionId}, transient: true}` BEFORE the model produces tokens. `useChat({ onData: ({type, data}) => ... })` reads it and the page pins `activeSessionId`. Transient parts never appear in `messages` — only `onData` sees them.

- Don't try to read `sessionId` from the `messages` array — it isn't there.
- New custom data parts: pick `data-${name}`, decide transient vs persistent (transient = ephemeral signal, non-transient = lands in `responseMessage.parts`).

## Attachments: pending → committed flow

1. User picks/drops files (textarea container has `onDragOver/Drop` gated on `dataTransfer.types.includes("Files")` AND `acceptsAttachments`).
2. `uploadFiles(files)` POSTs multipart to `/api/uploads`. Server returns `{pendingId, url: "/api/attachments/__pending__/<id>/<file>", kind, mediaType, size, filename}` per file.
3. Web stages chips with the pending URL + a local `URL.createObjectURL(file)` preview for image MIME types.
4. On send: `sendMessage({role:"user", parts:[ {type:"text",text}, {type:"file", url: pendingUrl, mediaType, filename}, ... ]})`.
5. Server's `/api/chat` validates pendings, moves files to `<sessionId>/<attId>/<file>`, rewrites URLs in the messages it persists. The web's local optimistic chip stays the same — useChat's `messages[lastUser]` carries the new URL after streaming finishes.

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
