import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { UIMessage } from "@openacme/agent-core";
import type { PendingAttachment } from "./state.js";

const ALLOWED_MIME: Record<string, "image" | "file"> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "application/pdf": "file",
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;

type FileUIPart = Extract<
  UIMessage["parts"][number],
  { type: "file" }
>;

/**
 * Strip outer quotes, unescape backslash-escaped spaces, expand `~`.
 * Terminals deliver dropped files as path strings — Terminal.app and
 * iTerm2 quote with single quotes when the path has spaces, kitty uses
 * backslash escapes, VS Code on macOS drops the raw path with literal
 * spaces, Windows Terminal usually delivers a raw path.
 */
export function normalizeDroppedPath(raw: string): string {
  let s = raw.trim();
  // Trim trailing control bytes some terminals append after a drop.
  s = s.replace(/[\x00-\x08\x0b-\x1f\x7f]+$/u, "");
  if (
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2) ||
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
  ) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\\ /g, " ");
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(s.slice("file://".length));
    } catch {
      s = s.slice("file://".length);
    }
  }
  if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1));
  return s;
}

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

/**
 * Resolve a path to a `PendingAttachment`. Rejects with a string error
 * message if the path is missing, too large, or has an unsupported type.
 */
export function loadAttachment(rawPath: string): PendingAttachment | string {
  const abs = path.resolve(normalizeDroppedPath(rawPath));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return `not found: ${rawPath}`;
  }
  if (!stat.isFile()) return `not a file: ${rawPath}`;
  if (stat.size > MAX_FILE_BYTES) {
    return `too large (max ${MAX_FILE_BYTES} bytes): ${path.basename(abs)}`;
  }
  const fd = fs.openSync(abs, "r");
  const head = Buffer.alloc(12);
  try {
    fs.readSync(fd, head, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  const mime = sniffMime(head);
  if (!mime || !ALLOWED_MIME[mime]) {
    return `unsupported type: ${path.basename(abs)} (only PNG/JPEG/WebP/GIF/PDF allowed)`;
  }
  return {
    sourcePath: abs,
    filename: path.basename(abs),
    mediaType: mime,
    size: stat.size,
    kind: ALLOWED_MIME[mime]!,
  };
}

/**
 * Stage a pending attachment under the session's attachments dir and
 * return a FileUIPart whose URL points at the static-serve route. CLI
 * runs in-process and persists straight to disk — no /api/uploads
 * round-trip. The URL form matches the server's static-serve so the
 * web UI can also render the same file if a chat is later opened
 * there.
 */
export function commitAttachmentForCli(
  attachmentsRoot: string,
  sessionId: string,
  p: PendingAttachment
): FileUIPart {
  const attId = `att_${randomUUID()}`;
  const destDir = path.join(attachmentsRoot, sessionId, attId);
  const destAbs = path.join(destDir, p.filename);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(p.sourcePath, destAbs);
  return {
    type: "file",
    url: `/api/attachments/${sessionId}/${attId}/${p.filename}`,
    mediaType: p.mediaType,
    filename: p.filename,
  } as unknown as FileUIPart;
}

/**
 * Does the buffer look like a single dropped-file path? We don't try to
 * be clever about whitespace heuristics — VS Code on macOS drops paths
 * with literal spaces and no escapes, so we let `statSync` arbitrate
 * after normalization. The only structural rejections are: empty, has
 * an embedded newline (multi-line text isn't a path), or doesn't
 * resolve to an existing file.
 */
export function looksLikeDroppedPath(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\n")) return false;
  const normalized = normalizeDroppedPath(trimmed);
  if (!normalized) return false;
  try {
    return fs.statSync(path.resolve(normalized)).isFile();
  } catch {
    return false;
  }
}

/**
 * Pull `@<path>` tokens out of free text. Returns the cleaned text plus
 * each extracted path string (already normalized).
 */
export function extractAtPaths(text: string): { cleaned: string; paths: string[] } {
  const paths: string[] = [];
  const cleaned = text.replace(
    /(^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g,
    (_match, lead: string, dq?: string, sq?: string, plain?: string) => {
      const p = dq ?? sq ?? plain ?? "";
      if (p) paths.push(p);
      return lead || "";
    }
  );
  return { cleaned: cleaned.replace(/\s{2,}/g, " ").trim(), paths };
}
