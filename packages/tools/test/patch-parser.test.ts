import { describe, it, expect } from "vitest";
import {
  parsePatch,
  deriveNewContentsFromString,
} from "../src/patch/parser.js";

describe("parsePatch", () => {
  it("parses an update hunk", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      " const x = 1",
      "-const y = 2",
      "+const y = 3",
      " const z = 4",
      "*** End Patch",
    ].join("\n");

    const { hunks } = parsePatch(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ type: "update", path: "a.ts" });
    if (hunks[0]!.type !== "update") throw new Error("type guard");
    expect(hunks[0]!.chunks[0]!.old_lines).toEqual([
      "const x = 1",
      "const y = 2",
      "const z = 4",
    ]);
    expect(hunks[0]!.chunks[0]!.new_lines).toEqual([
      "const x = 1",
      "const y = 3",
      "const z = 4",
    ]);
  });

  it("parses an add hunk", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.ts",
      "+export const hello = 'world'",
      "+",
      "*** End Patch",
    ].join("\n");

    const { hunks } = parsePatch(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual({
      type: "add",
      path: "new.ts",
      contents: "export const hello = 'world'\n",
    });
  });

  it("parses a delete hunk", () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: gone.ts",
      "*** End Patch",
    ].join("\n");

    const { hunks } = parsePatch(patch);
    expect(hunks).toEqual([{ type: "delete", path: "gone.ts" }]);
  });

  it("parses multi-file patches", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "+a",
      "*** Update File: b.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: c.ts",
      "*** End Patch",
    ].join("\n");

    const { hunks } = parsePatch(patch);
    expect(hunks.map((h) => [h.type, h.path])).toEqual([
      ["add", "a.ts"],
      ["update", "b.ts"],
      ["delete", "c.ts"],
    ]);
  });

  it("parses move directive", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-foo",
      "+bar",
      "*** End Patch",
    ].join("\n");

    const { hunks } = parsePatch(patch);
    expect(hunks[0]).toMatchObject({
      type: "update",
      path: "src/old.ts",
      move_path: "src/new.ts",
    });
  });

  it("rejects patches missing markers", () => {
    expect(() => parsePatch("*** Update File: a.ts\n+x")).toThrow(
      /missing Begin\/End markers/,
    );
  });
});

describe("deriveNewContentsFromString", () => {
  const original = ["const x = 1", "const y = 2", "const z = 4", ""].join("\n");

  it("applies a clean update", () => {
    const { hunks } = parsePatch(
      [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        " const x = 1",
        "-const y = 2",
        "+const y = 3",
        " const z = 4",
        "*** End Patch",
      ].join("\n"),
    );
    if (hunks[0]!.type !== "update") throw new Error("type guard");
    const result = deriveNewContentsFromString(
      original,
      "a.ts",
      hunks[0]!.chunks,
    );
    expect(result.content).toBe(
      ["const x = 1", "const y = 3", "const z = 4", ""].join("\n"),
    );
  });

  it("falls back to whitespace-trimmed match when context drifts", () => {
    const drifted = ["const x = 1  ", "const y = 2", "const z = 4", ""].join(
      "\n",
    );
    const { hunks } = parsePatch(
      [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        " const x = 1",
        "-const y = 2",
        "+const y = 3",
        " const z = 4",
        "*** End Patch",
      ].join("\n"),
    );
    if (hunks[0]!.type !== "update") throw new Error("type guard");
    const result = deriveNewContentsFromString(
      drifted,
      "a.ts",
      hunks[0]!.chunks,
    );
    expect(result.content).toContain("const y = 3");
  });

  it("throws when context is unfindable", () => {
    const { hunks } = parsePatch(
      [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        " not in source",
        "-const y = 2",
        "+const y = 3",
        "*** End Patch",
      ].join("\n"),
    );
    if (hunks[0]!.type !== "update") throw new Error("type guard");
    expect(() =>
      deriveNewContentsFromString(original, "a.ts", hunks[0]!.chunks),
    ).toThrow(/Failed to find/);
  });

  it("preserves BOM if source had one", () => {
    const bomSource = "﻿" + original;
    const { hunks } = parsePatch(
      [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-const y = 2",
        "+const y = 99",
        "*** End Patch",
      ].join("\n"),
    );
    if (hunks[0]!.type !== "update") throw new Error("type guard");
    const result = deriveNewContentsFromString(
      bomSource,
      "a.ts",
      hunks[0]!.chunks,
    );
    expect(result.bom).toBe(true);
    expect(result.content.startsWith("﻿")).toBe(false);
  });
});
