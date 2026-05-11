import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/store.js";

const AGENT_ID = "test-agent";
const CHAR_LIMIT = 2200;

let agentsDir: string;
let store: MemoryStore;

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "openacme-mem-"));
  store = new MemoryStore(agentsDir);
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

describe("path translation + traversal protection", () => {
  it("rejects paths not starting with /memories", async () => {
    const result = store.view(AGENT_ID, "/etc/passwd");
    expect(result).toContain("does not exist");
  });

  it("rejects ../ traversal", async () => {
    const result = store.view(AGENT_ID, "/memories/../../../etc/passwd");
    expect(result).toContain("does not exist");
  });

  it("rejects URL-encoded traversal (%2e%2e%2f)", async () => {
    const result = store.view(AGENT_ID, "/memories/%2e%2e%2f%2e%2e%2fetc/passwd");
    expect(result).toContain("does not exist");
  });

  it("rejects %2F separator injection", async () => {
    const result = store.view(AGENT_ID, "/memories/foo%2F..%2Fbar");
    expect(result).toContain("does not exist");
  });

  it("dirPath rejects unsafe agent ids", () => {
    expect(() => store.dirPath("../escape")).toThrow();
    expect(() => store.dirPath("with spaces")).toThrow();
    expect(() => store.dirPath("")).toThrow();
  });

  it("accepts valid agent ids and well-formed paths", async () => {
    // Empty memory dir; view returns the (empty) directory listing form
    const result = store.view(AGENT_ID, "/memories");
    expect(result).toContain("/memories");
  });
});

describe("create", () => {
  it("creates a new file successfully (Anthropic-verbatim message)", async () => {
    const r = await store.create(AGENT_ID, "/memories/notes.txt", "hello\n", CHAR_LIMIT);
    expect(r).toBe("File created successfully at: /memories/notes.txt");
    const abs = join(store.dirPath(AGENT_ID), "notes.txt");
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf-8")).toBe("hello\n");
  });

  it("errors when file already exists (Anthropic-verbatim message)", async () => {
    await store.create(AGENT_ID, "/memories/notes.txt", "first", CHAR_LIMIT);
    const r = await store.create(AGENT_ID, "/memories/notes.txt", "second", CHAR_LIMIT);
    expect(r).toBe("Error: File /memories/notes.txt already exists");
  });

  it("rejects writes to MEMORY.md exceeding the index char cap with OpenAcme guidance", async () => {
    const huge = "x".repeat(CHAR_LIMIT + 100);
    const r = await store.create(AGENT_ID, "/memories/MEMORY.md", huge, CHAR_LIMIT);
    expect(r).toContain("Memory at");
    expect(r).toContain(`${CHAR_LIMIT} chars`);
    expect(r).toContain("Replace or remove existing entries first");
  });

  it("does NOT enforce char cap on entry files (only MEMORY.md is capped)", async () => {
    const huge = "x".repeat(CHAR_LIMIT + 100);
    const r = await store.create(AGENT_ID, "/memories/big.md", huge, CHAR_LIMIT);
    expect(r).toBe("File created successfully at: /memories/big.md");
  });

  it("enforces 999,999-line cap with verbatim error string", async () => {
    const lines = "a\n".repeat(1_000_000);
    const r = await store.create(AGENT_ID, "/memories/huge.md", lines, CHAR_LIMIT);
    expect(r).toBe("File /memories/huge.md exceeds maximum line limit of 999,999 lines.");
  });
});

describe("view", () => {
  it("returns Anthropic file-content format with line numbers (1-indexed, 6-char width)", async () => {
    await store.create(AGENT_ID, "/memories/MEMORY.md", "alpha\nbeta\ngamma", CHAR_LIMIT);
    const r = store.view(AGENT_ID, "/memories/MEMORY.md");
    expect(r.startsWith("Here's the content of /memories/MEMORY.md with line numbers:")).toBe(true);
    expect(r).toContain("     1\talpha");
    expect(r).toContain("     2\tbeta");
    expect(r).toContain("     3\tgamma");
  });

  it("does NOT prepend a freshness wrapper for MEMORY.md (the index)", async () => {
    await store.create(AGENT_ID, "/memories/MEMORY.md", "hi", CHAR_LIMIT);
    // Backdate the file
    const abs = join(store.dirPath(AGENT_ID), "MEMORY.md");
    const past = (Date.now() - 47 * 86_400_000) / 1000;
    utimesSync(abs, past, past);
    const r = store.view(AGENT_ID, "/memories/MEMORY.md");
    expect(r).not.toContain("<system-reminder>");
    expect(r).not.toContain("days old");
  });

  it("DOES prepend a freshness wrapper for entry files older than 1 day", async () => {
    await store.create(AGENT_ID, "/memories/old.md", "stale fact", CHAR_LIMIT);
    const abs = join(store.dirPath(AGENT_ID), "old.md");
    const past = (Date.now() - 47 * 86_400_000) / 1000;
    utimesSync(abs, past, past);
    const r = store.view(AGENT_ID, "/memories/old.md");
    expect(r).toContain("<system-reminder>This memory is 47 days old");
    expect(r).toContain("Verify against current code");
  });

  it("does not freshness-wrap entry files ≤ 1 day old", async () => {
    await store.create(AGENT_ID, "/memories/fresh.md", "current fact", CHAR_LIMIT);
    const r = store.view(AGENT_ID, "/memories/fresh.md");
    expect(r).not.toContain("<system-reminder>");
  });

  it("returns Anthropic directory-listing header for a dir path", async () => {
    await store.create(AGENT_ID, "/memories/MEMORY.md", "", CHAR_LIMIT);
    await store.create(AGENT_ID, "/memories/notes.md", "stuff", CHAR_LIMIT);
    const r = store.view(AGENT_ID, "/memories");
    expect(r.startsWith("Here're the files and directories up to 2 levels deep in /memories")).toBe(true);
    expect(r).toContain("/memories/MEMORY.md");
    expect(r).toContain("/memories/notes.md");
  });

  it("excludes hidden dotfiles from directory listings", async () => {
    const dir = store.dirPath(AGENT_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".hidden"), "x");
    writeFileSync(join(dir, ".internal"), "");
    writeFileSync(join(dir, "real.md"), "z");
    const r = store.view(AGENT_ID, "/memories");
    expect(r).toContain("/memories/real.md");
    expect(r).not.toContain("/memories/.hidden");
    expect(r).not.toContain("/memories/.internal");
  });

  it("listing header reflects what we actually exclude (only hidden, not node_modules)", async () => {
    const r = store.view(AGENT_ID, "/memories");
    expect(r).toContain("excluding hidden items");
    // We dropped Anthropic's `node_modules` clause because it can never
    // appear in OpenAcme's memory dir (no shell, no package manager).
    // The header must not claim to filter what we don't filter.
    expect(r).not.toContain("node_modules");
  });

  it("returns 'does not exist' for missing files", async () => {
    const r = store.view(AGENT_ID, "/memories/nope.md");
    expect(r).toBe("The path /memories/nope.md does not exist. Please provide a valid path.");
  });
});

describe("str_replace", () => {
  beforeEach(async () => {
    await store.create(AGENT_ID, "/memories/notes.md", "alpha\nbeta\ngamma", CHAR_LIMIT);
  });

  it("replaces a unique substring and returns the Anthropic-verbatim success", async () => {
    const r = await store.strReplace(AGENT_ID, "/memories/notes.md", "beta", "BETA");
    expect(r.startsWith("The memory file has been edited.")).toBe(true);
    const content = readFileSync(join(store.dirPath(AGENT_ID), "notes.md"), "utf-8");
    expect(content).toBe("alpha\nBETA\ngamma");
  });

  it("errors with verbatim string when substring is not found", async () => {
    const r = await store.strReplace(AGENT_ID, "/memories/notes.md", "delta", "DELTA");
    expect(r).toBe(
      "No replacement was performed, old_str `delta` did not appear verbatim in /memories/notes.md."
    );
  });

  it("errors with verbatim string + line numbers when substring matches multiple times", async () => {
    await store.strReplace(AGENT_ID, "/memories/notes.md", "alpha\nbeta\ngamma", "x\nx\nx");
    const r = await store.strReplace(AGENT_ID, "/memories/notes.md", "x", "y");
    expect(r).toMatch(/^No replacement was performed\. Multiple occurrences of old_str `x` in lines: 1, 2, 3\. Please ensure it is unique$/);
  });

  it("errors when target file is missing (verbatim message)", async () => {
    const r = await store.strReplace(AGENT_ID, "/memories/missing.md", "x", "y");
    expect(r).toBe("Error: The path /memories/missing.md does not exist. Please provide a valid path.");
  });

  it("errors when target is a directory (treated as 'does not exist' per Anthropic spec)", async () => {
    mkdirSync(join(store.dirPath(AGENT_ID), "subdir"), { recursive: true });
    const r = await store.strReplace(AGENT_ID, "/memories/subdir", "x", "y");
    expect(r).toBe("Error: The path /memories/subdir does not exist. Please provide a valid path.");
  });
});

describe("insert", () => {
  beforeEach(async () => {
    await store.create(AGENT_ID, "/memories/list.md", "one\ntwo\nthree", CHAR_LIMIT);
  });

  it("inserts at line N and returns Anthropic-verbatim success", async () => {
    const r = await store.insert(AGENT_ID, "/memories/list.md", 2, "TWO-AND-A-HALF");
    expect(r).toBe("The file /memories/list.md has been edited.");
    const content = readFileSync(join(store.dirPath(AGENT_ID), "list.md"), "utf-8");
    expect(content).toBe("one\ntwo\nTWO-AND-A-HALF\nthree");
  });

  it("rejects out-of-range insert_line with verbatim error", async () => {
    const r = await store.insert(AGENT_ID, "/memories/list.md", 99, "x");
    expect(r).toBe("Error: Invalid `insert_line` parameter: 99. It should be within the range of lines of the file: [0, 3]");
  });

  it("rejects negative insert_line", async () => {
    const r = await store.insert(AGENT_ID, "/memories/list.md", -1, "x");
    expect(r).toContain("Invalid `insert_line` parameter: -1");
  });

  it("errors when target file is missing (verbatim short message)", async () => {
    const r = await store.insert(AGENT_ID, "/memories/missing.md", 0, "x");
    expect(r).toBe("Error: The path /memories/missing.md does not exist");
  });
});

describe("delete", () => {
  it("deletes a file and returns Anthropic-verbatim success", async () => {
    await store.create(AGENT_ID, "/memories/notes.md", "stuff", CHAR_LIMIT);
    const r = await store.delete(AGENT_ID, "/memories/notes.md");
    expect(r).toBe("Successfully deleted /memories/notes.md");
    expect(existsSync(join(store.dirPath(AGENT_ID), "notes.md"))).toBe(false);
  });

  it("recursively deletes a directory", async () => {
    const dir = store.dirPath(AGENT_ID);
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "a.md"), "x");
    writeFileSync(join(dir, "sub", "b.md"), "y");
    const r = await store.delete(AGENT_ID, "/memories/sub");
    expect(r).toBe("Successfully deleted /memories/sub");
    expect(existsSync(join(dir, "sub"))).toBe(false);
  });

  it("errors when target is missing (verbatim short message)", async () => {
    const r = await store.delete(AGENT_ID, "/memories/missing.md");
    expect(r).toBe("Error: The path /memories/missing.md does not exist");
  });
});

describe("rename", () => {
  beforeEach(async () => {
    await store.create(AGENT_ID, "/memories/draft.md", "x", CHAR_LIMIT);
  });

  it("renames and returns Anthropic-verbatim success", async () => {
    const r = await store.rename(AGENT_ID, "/memories/draft.md", "/memories/final.md");
    expect(r).toBe("Successfully renamed /memories/draft.md to /memories/final.md");
    expect(existsSync(join(store.dirPath(AGENT_ID), "final.md"))).toBe(true);
    expect(existsSync(join(store.dirPath(AGENT_ID), "draft.md"))).toBe(false);
  });

  it("errors when source is missing", async () => {
    const r = await store.rename(AGENT_ID, "/memories/missing.md", "/memories/x.md");
    expect(r).toBe("Error: The path /memories/missing.md does not exist");
  });

  it("errors when destination already exists (no overwrite)", async () => {
    await store.create(AGENT_ID, "/memories/final.md", "y", CHAR_LIMIT);
    const r = await store.rename(AGENT_ID, "/memories/draft.md", "/memories/final.md");
    expect(r).toBe("Error: The destination /memories/final.md already exists");
  });
});

describe("readIndex", () => {
  it("returns an empty snapshot when MEMORY.md doesn't exist", () => {
    const s = store.readIndex(AGENT_ID, CHAR_LIMIT);
    expect(s.content).toBe("");
    expect(s.used).toBe(0);
    expect(s.limit).toBe(CHAR_LIMIT);
    expect(s.entryCount).toBe(0);
  });

  it("returns content + entry count", async () => {
    await store.create(AGENT_ID, "/memories/MEMORY.md", "- [a](a.md)\n- [b](b.md)", CHAR_LIMIT);
    await store.create(AGENT_ID, "/memories/a.md", "first", CHAR_LIMIT);
    await store.create(AGENT_ID, "/memories/b.md", "second", CHAR_LIMIT);
    const s = store.readIndex(AGENT_ID, CHAR_LIMIT);
    expect(s.content).toBe("- [a](a.md)\n- [b](b.md)");
    expect(s.used).toBe(s.content.length);
    expect(s.entryCount).toBe(2);
  });
});

describe("concurrent writes serialize via mutex", () => {
  it("five parallel creates against the same agent all complete (no torn writes)", async () => {
    const ops = [
      store.create(AGENT_ID, "/memories/a.md", "1", CHAR_LIMIT),
      store.create(AGENT_ID, "/memories/b.md", "2", CHAR_LIMIT),
      store.create(AGENT_ID, "/memories/c.md", "3", CHAR_LIMIT),
      store.create(AGENT_ID, "/memories/d.md", "4", CHAR_LIMIT),
      store.create(AGENT_ID, "/memories/e.md", "5", CHAR_LIMIT),
    ];
    const results = await Promise.all(ops);
    for (const r of results) expect(r).toMatch(/^File created successfully at:/);
    const s = store.readIndex(AGENT_ID, CHAR_LIMIT);
    expect(s.entryCount).toBe(5);
  });
});
