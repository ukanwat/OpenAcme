import type { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentManager } from "../agent-manager.js";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;
export const PENDING_TTL_MS = 30 * 60 * 1000;

type AttachmentKind = "image" | "file";

const ALLOWED_MIME: Record<string, AttachmentKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "application/pdf": "file",
};

export interface PendingEntry {
  pendingId: string;
  /** absolute path to the file under <attachmentsRoot>/__pending__/<id>/<name> */
  absPath: string;
  filename: string;
  kind: AttachmentKind;
  mediaType: string;
  size: number;
  createdAt: number;
}

/**
 * Sniff mime type by magic bytes — browser-supplied `file.type` is a UA
 * hint we don't trust.
 */
function sniffMime(head: Buffer): string | null {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
    return "image/gif";
  }
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) {
    return "image/webp";
  }
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) {
    return "application/pdf";
  }
  return null;
}

function sanitizeBasename(name: string): string {
  const base = name.replace(/[\\/\x00]/g, "_").replace(/^\.+/, "");
  if (!base || base === "." || base === "..") return "file";
  return base.length > 200 ? base.slice(0, 200) : base;
}

export interface UploadsContext {
  /** pendingId → on-disk metadata; used by /api/chat to commit + rewrite URL. */
  pending: Map<string, PendingEntry>;
  attachmentsRoot: string;
  pendingRoot: string;
  /**
   * Move a pending file under the session's directory and remove it from
   * the pending map. Returns the committed `/api/attachments/<...>` URL,
   * or null if the pendingId is unknown.
   */
  commit(pendingId: string, sessionId: string): {
    url: string;
    filename: string;
    mediaType: string;
    kind: AttachmentKind;
    size: number;
  } | null;
}

/**
 * Register `/api/uploads` (multipart upload to a pending area) and
 * `/api/attachments/:sessionId/:attachmentId/:filename` (static-file
 * serving from disk). The pending file is moved under the real session
 * dir at chat-send time by `commit()`.
 *
 * No DB sidecar — the URL alone resolves to disk: `/api/attachments/`
 * concat with `<sessionId>/<attId>/<filename>` is the relative path
 * under `<attachmentsRoot>`.
 */
export function registerUploadsRoutes(
  app: Hono,
  manager: AgentManager
): UploadsContext {
  const attachmentsRoot = manager.attachmentsRoot;
  const pendingRoot = path.join(attachmentsRoot, "__pending__");
  const pending = new Map<string, PendingEntry>();

  // Boot-time sweep: anything left over from a previous process is gone.
  try {
    fs.rmSync(pendingRoot, { recursive: true, force: true });
  } catch (e) {
    console.error(
      `Failed to clear pending dir ${pendingRoot}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
  try {
    fs.mkdirSync(pendingRoot, { recursive: true });
  } catch (e) {
    console.error(
      `Failed to create pending dir ${pendingRoot}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  // TTL sweep every 5 min.
  const sweepHandle = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of pending) {
      if (now - entry.createdAt < PENDING_TTL_MS) continue;
      pending.delete(id);
      try {
        fs.rmSync(path.dirname(entry.absPath), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }, 5 * 60 * 1000);
  if (typeof sweepHandle.unref === "function") sweepHandle.unref();

  app.post("/api/uploads", async (c) => {
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: "Expected multipart/form-data" }, 400);
    }

    const files: File[] = [];
    for (const value of Object.values(form)) {
      const arr = Array.isArray(value) ? value : [value];
      for (const v of arr) {
        if (v instanceof File) files.push(v);
      }
    }
    if (files.length === 0) return c.json({ error: "No files in upload" }, 400);
    if (files.length > MAX_FILES) {
      return c.json({ error: `Too many files (max ${MAX_FILES})` }, 400);
    }

    let totalBytes = 0;
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) {
        return c.json(
          { error: `File '${f.name}' exceeds ${MAX_FILE_BYTES} bytes` },
          413
        );
      }
      totalBytes += f.size;
      if (totalBytes > MAX_REQUEST_BYTES) {
        return c.json(
          { error: `Upload exceeds ${MAX_REQUEST_BYTES} bytes` },
          413
        );
      }
    }

    const created: Array<{
      pendingId: string;
      kind: AttachmentKind;
      mediaType: string;
      size: number;
      filename: string;
      url: string;
    }> = [];

    for (const f of files) {
      const bytes = Buffer.from(await f.arrayBuffer());
      const sniffed = sniffMime(bytes.subarray(0, 12));
      if (!sniffed || !ALLOWED_MIME[sniffed]) {
        return c.json(
          {
            error: `File '${f.name}' has unsupported type (sniffed: ${sniffed ?? "unknown"})`,
            allowed: Object.keys(ALLOWED_MIME),
          },
          400
        );
      }
      const pendingId = `pend_${randomUUID()}`;
      const safeName = sanitizeBasename(f.name);
      const dir = path.join(pendingRoot, pendingId);
      const abs = path.join(dir, safeName);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(abs, bytes);
      } catch (e) {
        return c.json(
          {
            error: `Failed to write upload: ${
              e instanceof Error ? e.message : String(e)
            }`,
          },
          500
        );
      }
      const entry: PendingEntry = {
        pendingId,
        absPath: abs,
        filename: safeName,
        kind: ALLOWED_MIME[sniffed]!,
        mediaType: sniffed,
        size: f.size,
        createdAt: Date.now(),
      };
      pending.set(pendingId, entry);
      // Pending URL — the client uses this in the FileUIPart it sends
      // back to /api/chat. The chat handler's `commit` rewrites it to
      // the real /api/attachments/<sessionId>/<attId>/<filename> form
      // before persisting the message.
      created.push({
        pendingId,
        kind: entry.kind,
        mediaType: entry.mediaType,
        size: entry.size,
        filename: entry.filename,
        url: `/api/attachments/__pending__/${pendingId}/${safeName}`,
      });
    }

    return c.json({ attachments: created });
  });

  // Static-style serve. `:filename` is the last path segment of the URL
  // we wrote into the FileUIPart — round-trips against disk under
  // <attachmentsRoot>/<sessionId>/<attachmentId>/<filename>. Pending
  // attachments (sessionId === "__pending__") use the same path layout.
  app.get(
    "/api/attachments/:sessionId/:attachmentId/:filename",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const attachmentId = c.req.param("attachmentId");
      const filename = c.req.param("filename");
      const rel = path.join(sessionId, attachmentId, filename);
      const abs = path.resolve(path.join(attachmentsRoot, rel));
      // Defense in depth: ensure the resolved path is inside the root.
      if (!abs.startsWith(path.resolve(attachmentsRoot) + path.sep)) {
        return c.json({ error: "Path escapes root" }, 400);
      }
      if (!fs.existsSync(abs)) return c.json({ error: "Not found" }, 404);
      const stat = fs.statSync(abs);
      const stream = fs.createReadStream(abs);
      const safeName = filename.replace(/"/g, "");
      c.header("Content-Length", String(stat.size));
      c.header("Content-Disposition", `inline; filename="${safeName}"`);
      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.on("data", (chunk: Buffer | string) =>
            controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
          );
          stream.on("end", () => controller.close());
          stream.on("error", (e) => controller.error(e));
        },
        cancel() {
          stream.destroy();
        },
      });
      return c.body(webStream);
    }
  );

  return {
    pending,
    attachmentsRoot,
    pendingRoot,
    commit(pendingId, sessionId) {
      const entry = pending.get(pendingId);
      if (!entry) return null;
      const newAttId = `att_${randomUUID()}`;
      const destDir = path.join(attachmentsRoot, sessionId, newAttId);
      const destAbs = path.join(destDir, entry.filename);
      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(entry.absPath, destAbs);
        // Rename leaves the pending dir empty — clean up.
        try {
          fs.rmdirSync(path.dirname(entry.absPath));
        } catch {
          // best-effort
        }
      } catch (e) {
        console.error(
          `Failed to commit attachment ${pendingId}: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
        // Leave the pending entry in place; sweeper will eventually
        // clean it up. Caller falls back to surfacing an error.
        return null;
      }
      pending.delete(pendingId);
      return {
        url: `/api/attachments/${sessionId}/${newAttId}/${entry.filename}`,
        filename: entry.filename,
        mediaType: entry.mediaType,
        kind: entry.kind,
        size: entry.size,
      };
    },
  };
}
