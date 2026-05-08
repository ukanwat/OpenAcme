import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { replace } from "../src/builtins/edit.js";
import { registry } from "../src/registry.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openacme-edit-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function runEdit(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = registry.get("edit");
  if (!tool) throw new Error("edit tool not registered");
  const out = await tool.handler({ replaceAll: false, ...args });
  return JSON.parse(out) as Record<string, unknown>;
}

describe("replace() cascade", () => {
  it("matches exact text", () => {
    expect(replace("a\nb\nc", "b", "B", false)).toBe("a\nB\nc");
  });

  it("falls back to line-trimmed match when indentation differs", () => {
    const source = "if (x) {\n  return 1;\n}";
    const find = "if (x) {\nreturn 1;\n}";
    expect(replace(source, find, "// replaced", false)).toBe("// replaced");
  });

  it("rejects ambiguous matches without replaceAll", () => {
    expect(() => replace("foo\nfoo\n", "foo", "bar", false)).toThrow(
      /multiple matches/,
    );
  });

  it("replaces all when requested", () => {
    expect(replace("foo\nfoo\n", "foo", "bar", true)).toBe("bar\nbar\n");
  });

  it("throws when oldString equals newString", () => {
    expect(() => replace("x", "x", "x", false)).toThrow(/identical/);
  });

  it("throws when text is not found", () => {
    expect(() => replace("hello", "world", "x", false)).toThrow(
      /Could not find/,
    );
  });

  it("matches multi-line block when whitespace drifts", () => {
    const source = [
      "function greet() {",
      "  console.log('hi');",
      "  return true;",
      "}",
    ].join("\n");
    // Same anchors, same middle content, different leading whitespace.
    const find = [
      "function greet() {",
      "    console.log('hi');",
      "    return true;",
      "}",
    ].join("\n");
    expect(replace(source, find, "// replaced", false)).toBe("// replaced");
  });
});

describe("edit tool", () => {
  it("edits an existing file", async () => {
    const file = path.join(tmp, "a.ts");
    await fs.writeFile(file, "const x = 1\nconst y = 2\n");
    const result = await runEdit({
      path: file,
      oldString: "const y = 2",
      newString: "const y = 99",
    });
    expect(result.success).toBe(true);
    expect(await fs.readFile(file, "utf-8")).toBe("const x = 1\nconst y = 99\n");
  });

  it("creates a file when oldString is empty", async () => {
    const file = path.join(tmp, "new.ts");
    const result = await runEdit({
      path: file,
      oldString: "",
      newString: "export const a = 1\n",
    });
    expect(result.success).toBe(true);
    expect(result.mode).toBe("created");
    expect(await fs.readFile(file, "utf-8")).toBe("export const a = 1\n");
  });

  it("refuses to clobber existing file via empty oldString", async () => {
    const file = path.join(tmp, "exists.ts");
    await fs.writeFile(file, "old");
    const result = await runEdit({
      path: file,
      oldString: "",
      newString: "new",
    });
    expect(result.error).toMatch(/already exists/);
    expect(await fs.readFile(file, "utf-8")).toBe("old");
  });

  it("fails on non-existent file with non-empty oldString", async () => {
    const result = await runEdit({
      path: path.join(tmp, "nope.ts"),
      oldString: "x",
      newString: "y",
    });
    expect(result.error).toMatch(/not found/);
  });

  it("preserves CRLF line endings", async () => {
    const file = path.join(tmp, "crlf.ts");
    await fs.writeFile(file, "a\r\nb\r\nc\r\n");
    const result = await runEdit({
      path: file,
      oldString: "b",
      newString: "B",
    });
    expect(result.success).toBe(true);
    expect(await fs.readFile(file, "utf-8")).toBe("a\r\nB\r\nc\r\n");
  });

  it("preserves BOM", async () => {
    const file = path.join(tmp, "bom.ts");
    await fs.writeFile(file, "﻿a\nb\n");
    const result = await runEdit({
      path: file,
      oldString: "b",
      newString: "B",
    });
    expect(result.success).toBe(true);
    const content = await fs.readFile(file, "utf-8");
    expect(content.startsWith("﻿")).toBe(true);
    expect(content).toBe("﻿a\nB\n");
  });

  it("serializes concurrent edits to the same file", async () => {
    const file = path.join(tmp, "race.ts");
    await fs.writeFile(file, "1\n");
    await Promise.all([
      runEdit({ path: file, oldString: "1", newString: "2" }),
      runEdit({ path: file, oldString: "2", newString: "3" }),
      runEdit({ path: file, oldString: "3", newString: "4" }),
    ]);
    expect((await fs.readFile(file, "utf-8")).trim()).toBe("4");
  });
});
