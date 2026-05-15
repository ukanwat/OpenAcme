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

## Dev = `:3000` (web), `:3210` (API only). Published = `:3210` (web + API).

`pnpm dev` runs Next dev (3000) and Hono (3210) side by side. Hono is **API-only in dev** — it does not mount any static UI. Open `:3000` for the webapp; HMR works there.

- The bundled `packages/server/web/` only exists in published `@openacme/server` installs (materialized at publish time by `prepack`). In the workspace it's absent, so Hono has nothing to serve and `:3210/` is API-only.
- Don't reintroduce a workspace `apps/web/out` fallback in Hono — that's what made `:3210` show a stale UI alongside `:3000`.
- Don't try to stream HMR through Hono — the dev server is meant for that.

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

`app/lib/api.ts` carries `API_BASE` (default `""` for same-origin). When the bundle is served from Hono itself, same-origin works; in dev (Next at :3000 → Hono at :3210), `next.config.js` rewrites `/api/*`.

- Don't hardcode `http://localhost:3210` elsewhere. Threading `API_BASE` through is the only way same-origin static and split-port dev both keep working.
