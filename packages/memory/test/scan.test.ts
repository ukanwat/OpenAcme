import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  scanMemoryFiles,
  formatMemoryManifest,
  parseFrontmatterDescription,
} from "../src/scan.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openacme-mem-scan-"));
}

function write(dir: string, rel: string, body: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf-8");
  return abs;
}

function entry(desc: string | null, body = "content"): string {
  if (desc === null) return body;
  return `---\nname: x\ndescription: ${desc}\n---\n\n${body}`;
}

describe("parseFrontmatterDescription", () => {
  it("returns null for files with no frontmatter", () => {
    expect(parseFrontmatterDescription("just a body")).toBeNull();
  });

  it("returns null when frontmatter is unclosed", () => {
    expect(parseFrontmatterDescription("---\nname: x\n")).toBeNull();
  });

  it("returns null when description is missing", () => {
    expect(parseFrontmatterDescription("---\nname: x\n---\n\nbody")).toBeNull();
  });

  it("strips quotes around the value", () => {
    expect(
      parseFrontmatterDescription(`---\ndescription: "quoted value"\n---`)
    ).toBe("quoted value");
    expect(
      parseFrontmatterDescription(`---\ndescription: 'single quoted'\n---`)
    ).toBe("single quoted");
  });

  it("trims unquoted values", () => {
    expect(
      parseFrontmatterDescription(`---\ndescription:   spaced out   \n---`)
    ).toBe("spaced out");
  });

  it("returns null for empty description", () => {
    expect(
      parseFrontmatterDescription(`---\ndescription: \n---`)
    ).toBeNull();
  });
});

describe("scanMemoryFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] for a missing directory", async () => {
    const out = await scanMemoryFiles(path.join(dir, "nope"));
    expect(out).toEqual([]);
  });

  it("returns [] for an empty directory", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const out = await scanMemoryFiles(dir);
    expect(out).toEqual([]);
  });

  it("excludes MEMORY.md", async () => {
    write(dir, "MEMORY.md", "- pointer");
    write(dir, "topic.md", entry("topic desc"));
    const out = await scanMemoryFiles(dir);
    expect(out.map((m) => m.filename)).toEqual(["topic.md"]);
  });

  it("excludes hidden dotfiles and dot-dirs", async () => {
    write(dir, "real.md", entry("ok"));
    write(dir, ".hidden.md", entry("hidden"));
    write(dir, ".sidecar/buried.md", entry("buried"));
    const out = await scanMemoryFiles(dir);
    expect(out.map((m) => m.filename)).toEqual(["real.md"]);
  });

  it("walks recursively into subdirs", async () => {
    write(dir, "a.md", entry("a"));
    write(dir, "topics/llms.md", entry("llms"));
    write(dir, "topics/sub/deep.md", entry("deep"));
    const out = await scanMemoryFiles(dir);
    const names = out.map((m) => m.filename).sort();
    expect(names).toEqual(["a.md", "topics/llms.md", "topics/sub/deep.md"]);
  });

  it("sorts newest-first by mtime", async () => {
    const a = write(dir, "old.md", entry("old"));
    const b = write(dir, "newer.md", entry("newer"));
    const c = write(dir, "newest.md", entry("newest"));
    const now = Date.now();
    fs.utimesSync(a, new Date(now - 3000) / 1000, new Date(now - 3000) / 1000);
    fs.utimesSync(b, new Date(now - 2000) / 1000, new Date(now - 2000) / 1000);
    fs.utimesSync(c, new Date(now - 1000) / 1000, new Date(now - 1000) / 1000);
    const out = await scanMemoryFiles(dir);
    expect(out.map((m) => m.filename)).toEqual([
      "newest.md",
      "newer.md",
      "old.md",
    ]);
  });

  it("preserves description from frontmatter", async () => {
    write(dir, "withdesc.md", entry("a clear hook"));
    write(dir, "nodesc.md", entry(null, "just body"));
    const out = await scanMemoryFiles(dir);
    const byName = Object.fromEntries(out.map((m) => [m.filename, m.description]));
    expect(byName["withdesc.md"]).toBe("a clear hook");
    expect(byName["nodesc.md"]).toBeNull();
  });

  it("respects an aborted signal cheaply", async () => {
    write(dir, "a.md", entry("a"));
    const ac = new AbortController();
    ac.abort();
    const out = await scanMemoryFiles(dir, ac.signal);
    expect(out).toEqual([]);
  });
});

describe("formatMemoryManifest", () => {
  it("includes description when present, omits when null", () => {
    const out = formatMemoryManifest([
      {
        filename: "a.md",
        filePath: "/x/a.md",
        mtimeMs: new Date("2026-05-10T12:00:00Z").getTime(),
        description: "first hook",
      },
      {
        filename: "b.md",
        filePath: "/x/b.md",
        mtimeMs: new Date("2026-05-09T12:00:00Z").getTime(),
        description: null,
      },
    ]);
    expect(out).toContain("- a.md (2026-05-10T12:00:00.000Z): first hook");
    expect(out).toContain("- b.md (2026-05-09T12:00:00.000Z)");
    expect(out).not.toContain("b.md (2026-05-09T12:00:00.000Z):");
  });
});
