import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registry } from "../src/registry.js";
import "../src/builtins/file.js";

const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAEElEQVR42mP8/5+hngEKGAEKKwIBxk97gAAAAABJRU5ErkJggg==";
const PDF_HEAD = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // "%PDF-1.4\n"
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF_HEAD = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP_HEAD = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "read-file-mm-"));
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function readFile(filePath: string, maxLines?: number): Promise<Record<string, unknown>> {
  const entry = registry.get("read_file");
  if (!entry) throw new Error("read_file not registered");
  const raw = await entry.handler({ path: filePath, ...(maxLines != null ? { maxLines } : {}) });
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("read_file multimodal", () => {
  it("returns a media pointer for PNG (no base64 inline)", async () => {
    const p = path.join(tmp, "r.png");
    fs.writeFileSync(p, Buffer.from(RED_PNG_B64, "base64"));
    const out = await readFile(p);
    expect(out._media).toBe("image");
    expect(out.mediaType).toBe("image/png");
    expect(out.path).toBe(p);
    expect(out.bytes).toBe(73);
    expect(out.content).toBeUndefined();
  });

  it("returns a media pointer for JPEG", async () => {
    const p = path.join(tmp, "x.jpg");
    fs.writeFileSync(p, JPEG_HEAD);
    const out = await readFile(p);
    expect(out._media).toBe("image");
    expect(out.mediaType).toBe("image/jpeg");
  });

  it("returns a media pointer for GIF", async () => {
    const p = path.join(tmp, "x.gif");
    fs.writeFileSync(p, GIF_HEAD);
    const out = await readFile(p);
    expect(out._media).toBe("image");
    expect(out.mediaType).toBe("image/gif");
  });

  it("returns a media pointer for WebP", async () => {
    const p = path.join(tmp, "x.webp");
    fs.writeFileSync(p, WEBP_HEAD);
    const out = await readFile(p);
    expect(out._media).toBe("image");
    expect(out.mediaType).toBe("image/webp");
  });

  it("returns a media pointer for PDF", async () => {
    const p = path.join(tmp, "doc.pdf");
    fs.writeFileSync(p, PDF_HEAD);
    const out = await readFile(p);
    expect(out._media).toBe("pdf");
    expect(out.mediaType).toBe("application/pdf");
  });

  it("returns text content for text files (existing behavior unchanged)", async () => {
    const p = path.join(tmp, "notes.md");
    fs.writeFileSync(p, "hello world\nline two\n");
    const out = await readFile(p);
    expect(out._media).toBeUndefined();
    expect(out.content).toBe("hello world\nline two\n");
    expect(out.success).toBe(true);
  });

  it("respects maxLines for text files", async () => {
    const p = path.join(tmp, "many.txt");
    fs.writeFileSync(p, "a\nb\nc\nd\ne\n");
    const out = await readFile(p, 2);
    expect(out.content).toBe("a\nb");
    expect(out.truncated).toBe(true);
  });

  it("refuses oversized images", async () => {
    const p = path.join(tmp, "big.png");
    const big = Buffer.alloc(6 * 1024 * 1024);
    Buffer.from(RED_PNG_B64, "base64").copy(big, 0);
    fs.writeFileSync(p, big);
    const out = await readFile(p);
    expect(out.error).toMatch(/image too large/i);
  });

  it("refuses oversized PDFs", async () => {
    const p = path.join(tmp, "big.pdf");
    const big = Buffer.alloc(11 * 1024 * 1024);
    PDF_HEAD.copy(big, 0);
    fs.writeFileSync(p, big);
    const out = await readFile(p);
    expect(out.error).toMatch(/pdf too large/i);
  });

  it("refuses unknown binary with a guiding error", async () => {
    const p = path.join(tmp, "bin");
    fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0xff]));
    const out = await readFile(p);
    expect(out.error).toMatch(/binary file with unrecognized type/);
  });

  it("refuses oversized text files with maxLines hint", async () => {
    const p = path.join(tmp, "huge.txt");
    fs.writeFileSync(p, "x".repeat(6 * 1024 * 1024));
    const out = await readFile(p);
    expect(out.error).toMatch(/text file too large/);
  });

  it("returns error for non-regular files", async () => {
    const p = path.join(tmp, "subdir");
    fs.mkdirSync(p);
    const out = await readFile(p);
    expect(out.error).toMatch(/not a regular file/);
  });
});
