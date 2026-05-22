import * as path from "node:path";
import type { Hono } from "hono";
import type { AgentManager } from "../agent-manager.js";
import { serveBinaryFile } from "./_serve-helpers.js";

/**
 * `/api/files/:sessionId/:fileId/:filename` — static-style serve for
 * agent-side binary content (read_file on image/PDF, screenshots, future
 * tools that need to surface bytes back to the chat UI). Scoped per
 * session by URL path segments.
 *
 * On-disk layout is `<agentDir>/sessions/<sessionId>/tool-calls/<fileId>-<filename>`
 * — flat naming so the existing `sweepOverflow` / `deleteSessionToolCalls`
 * cleanup machinery in `spill.ts` covers it. (The dir is named
 * "tool-calls" for legacy reasons; the content isn't strictly tool-only.)
 *
 * `sessionId → agentId` resolves via `sessionStore` so the URL doesn't
 * have to leak the agent id. Defense-in-depth: resolved path is pinned
 * under the session's tool-calls dir.
 *
 * Distinct from `/api/attachments/...` — that route serves user uploads
 * out of `<dataDir>/attachments/`. This route serves agent-side content
 * out of the per-session tool-calls tree. Different trust models, two
 * routes.
 */
export function registerFilesRoutes(app: Hono, manager: AgentManager): void {
  app.get(
    "/api/files/:sessionId/:fileId/:filename",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const fileId = c.req.param("fileId");
      const filename = c.req.param("filename");
      if (!sessionId || !fileId || !filename) {
        return c.json({ error: "missing parameter" }, 400);
      }

      const session = manager.sessionStore.get(sessionId);
      if (!session) return c.json({ error: "Not found" }, 404);

      const sessionDir = path.join(
        manager.agentsDir,
        session.agentId,
        "sessions",
        sessionId,
        "tool-calls"
      );
      const onDiskName = `${fileId}-${filename}`;
      const abs = path.resolve(path.join(sessionDir, onDiskName));
      if (!abs.startsWith(path.resolve(sessionDir) + path.sep)) {
        return c.json({ error: "Path escapes root" }, 400);
      }
      return serveBinaryFile(c, abs, filename);
    }
  );
}
