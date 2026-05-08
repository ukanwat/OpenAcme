import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { registry } from "../src/registry.js";
import "../src/builtins/apply-patch.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openacme-patch-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function runPatch(patchText: string, cwd = tmp) {
  const tool = registry.get("apply_patch");
  if (!tool) throw new Error("apply_patch not registered");
  return JSON.parse(await tool.handler({ patchText, cwd })) as Record<string, unknown>;
}

describe("apply_patch tool", () => {
  it("creates a new file via Add File hunk", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: greet.ts",
      "+export const greet = () => 'hi'",
      "+",
      "*** End Patch",
    ].join("\n");

    const result = await runPatch(patch);
    expect(result.success).toBe(true);
    expect(await fs.readFile(path.join(tmp, "greet.ts"), "utf-8")).toBe(
      "export const greet = () => 'hi'\n",
    );
  });

  it("updates an existing file", async () => {
    const file = path.join(tmp, "a.ts");
    await fs.writeFile(file, "const x = 1\nconst y = 2\nconst z = 3\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      " const x = 1",
      "-const y = 2",
      "+const y = 22",
      " const z = 3",
      "*** End Patch",
    ].join("\n");

    const result = await runPatch(patch);
    expect(result.success).toBe(true);
    expect(await fs.readFile(file, "utf-8")).toBe(
      "const x = 1\nconst y = 22\nconst z = 3\n",
    );
  });

  it("deletes a file", async () => {
    const file = path.join(tmp, "gone.ts");
    await fs.writeFile(file, "stuff");
    const result = await runPatch(
      ["*** Begin Patch", "*** Delete File: gone.ts", "*** End Patch"].join("\n"),
    );
    expect(result.success).toBe(true);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("rolls back when any hunk fails to apply", async () => {
    const a = path.join(tmp, "a.ts");
    const b = path.join(tmp, "b.ts");
    await fs.writeFile(a, "const a = 1\n");
    await fs.writeFile(b, "const b = 1\n");

    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      "-const a = 1",
      "+const a = 99",
      "*** Update File: b.ts",
      "@@",
      "-this line is not in b",
      "+replacement",
      "*** End Patch",
    ].join("\n");

    const result = await runPatch(patch);
    expect(result.error).toBeDefined();
    expect(await fs.readFile(a, "utf-8")).toBe("const a = 1\n");
    expect(await fs.readFile(b, "utf-8")).toBe("const b = 1\n");
  });

  it("refuses to add a file that already exists", async () => {
    await fs.writeFile(path.join(tmp, "x.ts"), "old");
    const result = await runPatch(
      ["*** Begin Patch", "*** Add File: x.ts", "+new", "*** End Patch"].join(
        "\n",
      ),
    );
    expect(result.error).toMatch(/already exists/);
    expect(await fs.readFile(path.join(tmp, "x.ts"), "utf-8")).toBe("old");
  });

  it("applies multi-file patches", async () => {
    await fs.writeFile(path.join(tmp, "b.ts"), "const b = 1\n");
    const patch = [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "+a",
      "*** Update File: b.ts",
      "@@",
      "-const b = 1",
      "+const b = 2",
      "*** End Patch",
    ].join("\n");
    const result = await runPatch(patch);
    expect(result.success).toBe(true);
    expect(await fs.readFile(path.join(tmp, "a.ts"), "utf-8")).toBe("a\n");
    expect(await fs.readFile(path.join(tmp, "b.ts"), "utf-8")).toBe("const b = 2\n");
  });

  it("returns error on malformed patch", async () => {
    const result = await runPatch("not a patch at all");
    expect(result.error).toMatch(/parse error/i);
  });
});
