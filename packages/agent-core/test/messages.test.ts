import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UIMessage } from "ai";
import {
  inlineFileAttachments,
  parseAttachmentUrl,
} from "../src/messages.js";

describe("parseAttachmentUrl", () => {
  it("parses /api/attachments/<session>/<id>/<file>", () => {
    expect(
      parseAttachmentUrl("/api/attachments/sess-1/att-2/shot.png")
    ).toBe("sess-1/att-2/shot.png");
  });

  it("preserves filenames with dots", () => {
    expect(
      parseAttachmentUrl("/api/attachments/s/a/has.many.dots.pdf")
    ).toBe("s/a/has.many.dots.pdf");
  });

  it("returns null for data: URLs", () => {
    expect(parseAttachmentUrl("data:image/png;base64,iVBOR")).toBe(null);
  });

  it("returns null for external URLs", () => {
    expect(parseAttachmentUrl("https://example.com/image.png")).toBe(null);
  });

  it("returns null for malformed paths missing segments", () => {
    expect(parseAttachmentUrl("/api/attachments/onlyone")).toBe(null);
    expect(parseAttachmentUrl("/api/attachments/")).toBe(null);
  });
});

describe("inlineFileAttachments", () => {
  it("rewrites local attachment URLs to data: URLs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-msg-"));
    const root = path.join(tmp, "attachments");
    const rel = "sess-1/att-1/pixel.png";
    fs.mkdirSync(path.join(root, "sess-1/att-1"), { recursive: true });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(path.join(root, rel), bytes);

    const input: UIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [
          { type: "text", text: "hi" },
          {
            type: "file",
            url: `/api/attachments/${rel}`,
            mediaType: "image/png",
            filename: "pixel.png",
          },
        ],
      },
    ];
    const out = inlineFileAttachments(input, root);
    expect(out[0]!.parts[0]).toEqual({ type: "text", text: "hi" });
    const filePart = out[0]!.parts[1] as { type: string; url: string };
    expect(filePart.type).toBe("file");
    expect(filePart.url.startsWith("data:image/png;base64,")).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes through non-attachment URLs unchanged", () => {
    const input: UIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [
          {
            type: "file",
            url: "https://example.com/x.png",
            mediaType: "image/png",
          },
        ],
      },
    ];
    const out = inlineFileAttachments(input, "/tmp/no-such-root");
    expect((out[0]!.parts[0] as { url: string }).url).toBe(
      "https://example.com/x.png"
    );
  });

  it("substitutes a placeholder text part when the file is missing", () => {
    const input: UIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [
          {
            type: "file",
            url: "/api/attachments/missing/missing/missing.png",
            mediaType: "image/png",
            filename: "missing.png",
          },
        ],
      },
    ];
    const out = inlineFileAttachments(input, "/tmp/nope");
    const part = out[0]!.parts[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("attachment unavailable");
    expect(part.text).toContain("missing.png");
  });
});
