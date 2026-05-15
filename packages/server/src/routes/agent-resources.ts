import type { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_RESOURCES_PER_AGENT } from "@openacme/config";
import type { AgentManager } from "../agent-manager.js";

const MAX_RESOURCE_FILE_BYTES = 1 * 1024 * 1024;
const MAX_RESOURCE_REQUEST_BYTES = 10 * 1024 * 1024;

/**
 * Map of common file extensions to a Content-Type. Resources are
 * user-supplied so we can't sniff for a closed set the way uploads
 * does. Extension-based dispatch is good enough for a download link;
 * falls back to `application/octet-stream`.
 */
const EXT_MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function mimeFor(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

function streamFile(absPath: string): ReadableStream<Uint8Array> {
  const node = fs.createReadStream(absPath);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on("data", (chunk: Buffer | string) =>
        controller.enqueue(
          typeof chunk === "string" ? Buffer.from(chunk) : chunk
        )
      );
      node.on("end", () => controller.close());
      node.on("error", (e) => controller.error(e));
    },
    cancel() {
      node.destroy();
    },
  });
}

/**
 * Register `/api/agents/:id/resources` (CRUD over the agent's
 * `resources/` subdir). Mirrors the route shape of `/api/skills/import`
 * for uploads and `/api/attachments/...` for downloads.
 */
export function registerAgentResourceRoutes(
  app: Hono,
  manager: AgentManager
): void {
  // List
  app.get("/api/agents/:id/resources", (c) => {
    const id = c.req.param("id");
    if (!manager.agentStore.get(id)) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const resources = manager.agentStore
      .listResources(id)
      .map((r) => ({ relPath: r.relPath, size: r.size }));
    return c.json({ resources });
  });

  // Download a single file. Hono's `*` capture lands the rest of the
  // path under a key conventionally named `*`; use req.path slicing for
  // robustness.
  app.get("/api/agents/:id/resources/*", (c) => {
    const id = c.req.param("id");
    if (!manager.agentStore.get(id)) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const prefix = `/api/agents/${id}/resources/`;
    const fullPath = c.req.path;
    if (!fullPath.startsWith(prefix)) {
      return c.json({ error: "Bad path" }, 400);
    }
    const relPath = decodeURIComponent(fullPath.slice(prefix.length));
    if (relPath.length === 0) {
      return c.json({ error: "Missing path" }, 400);
    }
    const abs = manager.agentStore.resourceAbsPath(id, relPath);
    if (!abs) return c.json({ error: "Invalid path" }, 400);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "Not found" }, 404);
      }
      throw e;
    }
    if (!stat.isFile()) return c.json({ error: "Not a file" }, 404);
    const filename = path.basename(abs);
    const asciiName = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
    c.header("Content-Length", String(stat.size));
    c.header("Content-Type", mimeFor(abs));
    c.header(
      "Content-Disposition",
      `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    return c.body(streamFile(abs));
  });

  // Upload. Multipart with field names = POSIX relPaths (matches the
  // `/api/skills/import` convention). The whole batch is validated
  // before any writes.
  app.post("/api/agents/:id/resources", async (c) => {
    const id = c.req.param("id");
    if (!manager.agentStore.get(id)) {
      return c.json({ error: "Agent not found" }, 404);
    }

    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: "Expected multipart/form-data" }, 400);
    }

    const entries: { relPath: string; file: File }[] = [];
    for (const [rawKey, raw] of Object.entries(form)) {
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (typeof value === "string") continue;
        if (!(value instanceof File)) continue;
        entries.push({
          relPath: rawKey || value.name,
          file: value,
        });
      }
    }

    if (entries.length === 0) {
      return c.json({ error: "No files in upload" }, 400);
    }

    // Validate count against the existing listing.
    const existing = manager.agentStore.listResources(id);
    if (existing.length + entries.length > MAX_RESOURCES_PER_AGENT) {
      return c.json(
        {
          error: `Adding ${entries.length} would exceed the ${MAX_RESOURCES_PER_AGENT}-file cap (currently ${existing.length}).`,
        },
        400
      );
    }

    let totalBytes = 0;
    for (const e of entries) {
      if (e.file.size > MAX_RESOURCE_FILE_BYTES) {
        return c.json(
          {
            error: `File '${e.relPath}' exceeds ${MAX_RESOURCE_FILE_BYTES} bytes`,
          },
          413
        );
      }
      totalBytes += e.file.size;
      if (totalBytes > MAX_RESOURCE_REQUEST_BYTES) {
        return c.json(
          { error: `Upload exceeds ${MAX_RESOURCE_REQUEST_BYTES} bytes` },
          413
        );
      }
      // Pre-validate the path so we don't half-write.
      const abs = manager.agentStore.resourceAbsPath(id, e.relPath);
      if (!abs) {
        return c.json({ error: `Invalid path: ${e.relPath}` }, 400);
      }
    }

    // All entries validated — write.
    for (const e of entries) {
      const bytes = Buffer.from(await e.file.arrayBuffer());
      try {
        manager.agentStore.writeResource(id, e.relPath, bytes);
      } catch (err) {
        return c.json(
          {
            error: `Failed to write '${e.relPath}': ${err instanceof Error ? err.message : String(err)}`,
          },
          500
        );
      }
    }

    manager.evictAgent(id);

    const resources = manager.agentStore
      .listResources(id)
      .map((r) => ({ relPath: r.relPath, size: r.size }));
    return c.json({ resources }, 201);
  });

  app.delete("/api/agents/:id/resources/*", (c) => {
    const id = c.req.param("id");
    if (!manager.agentStore.get(id)) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const prefix = `/api/agents/${id}/resources/`;
    const fullPath = c.req.path;
    if (!fullPath.startsWith(prefix)) {
      return c.json({ error: "Bad path" }, 400);
    }
    const relPath = decodeURIComponent(fullPath.slice(prefix.length));
    if (relPath.length === 0) {
      return c.json({ error: "Missing path" }, 400);
    }
    const abs = manager.agentStore.resourceAbsPath(id, relPath);
    if (!abs) return c.json({ error: "Invalid path" }, 400);
    const ok = manager.agentStore.deleteResource(id, relPath);
    if (!ok) return c.json({ error: "Not found" }, 404);
    manager.evictAgent(id);
    return c.json({ success: true });
  });
}
