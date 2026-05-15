import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { collectSurfacedMemories } from "../src/surfaced.js";

function asst(parts: unknown[]): UIMessage {
  return {
    id: `m_${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    parts: parts as UIMessage["parts"],
  };
}

function user(text: string): UIMessage {
  return {
    id: `u_${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

describe("collectSurfacedMemories", () => {
  it("returns empty set for an empty history", () => {
    const out = collectSurfacedMemories([]);
    expect(out.paths.size).toBe(0);
    expect(out.totalBytes).toBe(0);
  });

  it("ignores text and tool parts", () => {
    const out = collectSurfacedMemories([
      user("hi"),
      asst([
        { type: "text", text: "hello" },
        { type: "tool-shell", state: "output-available", input: {}, output: "" },
      ]),
    ]);
    expect(out.paths.size).toBe(0);
  });

  it("collects paths from data-relevant-memory parts", () => {
    const out = collectSurfacedMemories([
      asst([
        {
          type: "data-relevant-memory",
          data: {
            entries: [
              { path: "/x/a.md", mtimeMs: 1000, content: "AAA" },
              { path: "/x/b.md", mtimeMs: 2000, content: "BBBB" },
            ],
          },
        },
      ]),
    ]);
    expect(out.paths).toEqual(new Set(["/x/a.md", "/x/b.md"]));
    expect(out.totalBytes).toBe(7);
  });

  it("dedupes across multiple messages", () => {
    const out = collectSurfacedMemories([
      asst([
        {
          type: "data-relevant-memory",
          data: { entries: [{ path: "/x/a.md", mtimeMs: 1, content: "one" }] },
        },
      ]),
      user("next"),
      asst([
        {
          type: "data-relevant-memory",
          data: {
            entries: [
              { path: "/x/a.md", mtimeMs: 1, content: "one" },
              { path: "/x/c.md", mtimeMs: 2, content: "three" },
            ],
          },
        },
      ]),
    ]);
    expect(out.paths).toEqual(new Set(["/x/a.md", "/x/c.md"]));
  });

  it("tolerates malformed payloads without throwing", () => {
    const out = collectSurfacedMemories([
      asst([{ type: "data-relevant-memory" }]),
      asst([{ type: "data-relevant-memory", data: {} }]),
      asst([{ type: "data-relevant-memory", data: { entries: "nope" } }]),
      asst([
        {
          type: "data-relevant-memory",
          data: { entries: [{ mtimeMs: 1, content: "no path" }] },
        },
      ]),
    ]);
    expect(out.paths.size).toBe(0);
  });
});
