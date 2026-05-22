import * as fs from "node:fs";
import { Readable } from "node:stream";
import type { Context } from "hono";

/** Map common extensions to media types so the browser renders bytes
 *  inline (image previews, PDF viewer). Falls back to
 *  application/octet-stream — browser treats the response as opaque
 *  download. Shared by /api/attachments (user uploads) and /api/files
 *  (agent-side binary content). */
export function mimeForExt(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "pdf": return "application/pdf";
    case "svg": return "image/svg+xml";
    case "txt": return "text/plain; charset=utf-8";
    case "json": return "application/json";
    default: return "application/octet-stream";
  }
}

/** Stream a file as the response body with the right Content-Type +
 *  RFC 5987 Content-Disposition (non-ASCII filenames need the
 *  filename*= form or Response throws on header bytes). 404s on
 *  ENOENT instead of pre-checking — avoids the existsSync TOCTOU. */
export function serveBinaryFile(c: Context, abs: string, filename: string): Response {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
  const asciiName = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  c.header("Content-Type", mimeForExt(filename));
  c.header("Content-Length", String(stat.size));
  c.header(
    "Content-Disposition",
    `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  const nodeStream = fs.createReadStream(abs);
  return c.body(Readable.toWeb(nodeStream) as ReadableStream);
}
