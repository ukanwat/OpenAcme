import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import {
  maybeSpill,
  spillSnapshot,
  sweepOverflow,
  deleteSessionToolCalls,
  DEFAULT_SPILL_THRESHOLD,
  TOOL_CALLS_DIR,
  PREVIEW_CHARS,
} from "../src/spill.js";
import { toolCallContext } from "../src/session-context.js";
import type { ToolEntry } from "../src/types.js";

const noopHandler = async () => "";
const baseEntry: ToolEntry = {
  name: "test_tool",
  toolset: "test",
  description: "",
  parameters: z.object({}),
  handler: noopHandler,
};

const SESSION_ID = "session-uuid-12345678abcd";
let tmp: string;
let agentDir: string;
let workspaceDir: string;
let toolCallsDir: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openacme-spill-"));
  agentDir = path.join(tmp, "agents", "a1");
  workspaceDir = path.join(agentDir, "workspace");
  toolCallsDir = path.join(agentDir, "sessions", SESSION_ID, TOOL_CALLS_DIR);
  await fsp.mkdir(workspaceDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

function withCtx<T>(fn: () => Promise<T>): Promise<T> {
  return toolCallContext.run(
    { sessionId: SESSION_ID, agentId: "a1", workspaceDir },
    fn
  );
}

describe("maybeSpill", () => {
  it("passes through results under threshold", async () => {
    const result = "x".repeat(DEFAULT_SPILL_THRESHOLD - 1);
    const out = await withCtx(() => maybeSpill(result, baseEntry));
    expect(out).toBe(result);
    expect(fs.existsSync(toolCallsDir)).toBe(false);
  });

  it("spills above threshold and returns preview + trailer with absolute path", async () => {
    const body = "A".repeat(40_000);
    const out = await withCtx(() => maybeSpill(body, baseEntry));
    expect(out.startsWith("A".repeat(PREVIEW_CHARS))).toBe(true);
    // Trailer mentions absolute path under the session's tool-calls dir
    expect(out).toMatch(
      /\[overflow: [\d.]+ KB total — full result at \/.+\/sessions\/.+\/tool-calls\/.+\.txt/
    );
    const files = fs.readdirSync(toolCallsDir);
    expect(files).toHaveLength(1);
    const spilled = fs.readFileSync(path.join(toolCallsDir, files[0]!), "utf-8");
    expect(spilled).toBe(body);
    expect(files[0]).toMatch(/test_tool/);
  });

  it("respects per-tool maxResultSizeChars override", async () => {
    const entry: ToolEntry = { ...baseEntry, maxResultSizeChars: 100 };
    const body = "B".repeat(500);
    const out = await withCtx(() => maybeSpill(body, entry));
    expect(out).not.toBe(body);
    const files = fs.readdirSync(toolCallsDir);
    expect(files).toHaveLength(1);
  });

  it("skips spill when binaryResult flag is set", async () => {
    const entry: ToolEntry = { ...baseEntry, binaryResult: true };
    const body = "C".repeat(50_000);
    const out = await withCtx(() => maybeSpill(body, entry));
    expect(out).toBe(body);
    expect(fs.existsSync(toolCallsDir)).toBe(false);
  });

  it("falls back to returning the result verbatim when no workspace context", async () => {
    const body = "D".repeat(40_000);
    const out = await maybeSpill(body, baseEntry);
    expect(out).toBe(body);
  });

  it("returns result verbatim if the write fails", async () => {
    // Make the agent dir (workspaceDir's parent) a regular file so
    // mkdir of sessions/<id>/tool-calls underneath it fails.
    const badAgentDir = path.join(tmp, "agent-as-file");
    fs.writeFileSync(badAgentDir, "blocker");
    const fakeWorkspace = path.join(badAgentDir, "workspace");
    const body = "E".repeat(40_000);
    const out = await toolCallContext.run(
      { sessionId: "s", agentId: "a1", workspaceDir: fakeWorkspace },
      () => maybeSpill(body, baseEntry)
    );
    expect(out).toBe(body);
  });
});

describe("spillSnapshot", () => {
  it("always writes (even tiny inputs) and returns an absolute path", async () => {
    const tiny = "- button [ref=e1]";
    const p = await withCtx(() => Promise.resolve(spillSnapshot(tiny)));
    expect(p).not.toBeNull();
    expect(path.isAbsolute(p!)).toBe(true);
    expect(p!).toContain(`/sessions/${SESSION_ID}/${TOOL_CALLS_DIR}/`);
    expect(p!.endsWith(".yml")).toBe(true);
    expect(fs.readFileSync(p!, "utf-8")).toBe(tiny);
  });

  it("filename uses 'snapshot-' prefix", async () => {
    const p = await withCtx(() =>
      Promise.resolve(spillSnapshot("- generic [ref=e2]"))
    );
    expect(path.basename(p!)).toMatch(/^snapshot-/);
  });

  it("returns null when no workspace context", () => {
    expect(spillSnapshot("- whatever")).toBeNull();
  });
});

describe("sweepOverflow", () => {
  it("removes files older than maxAgeMs and leaves fresh ones", async () => {
    await fsp.mkdir(toolCallsDir, { recursive: true });
    const old = path.join(toolCallsDir, "old.txt");
    const fresh = path.join(toolCallsDir, "fresh.txt");
    fs.writeFileSync(old, "OLD");
    fs.writeFileSync(fresh, "FRESH");
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, oldTime, oldTime);

    const result = sweepOverflow(
      path.join(tmp, "agents"),
      7 * 24 * 60 * 60 * 1000
    );
    expect(result.removed).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("removes empty tool-calls + session dirs after sweep", async () => {
    await fsp.mkdir(toolCallsDir, { recursive: true });
    const old = path.join(toolCallsDir, "old.txt");
    fs.writeFileSync(old, "OLD");
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, oldTime, oldTime);

    sweepOverflow(path.join(tmp, "agents"), 7 * 24 * 60 * 60 * 1000);
    expect(fs.existsSync(toolCallsDir)).toBe(false);
    // session dir cleaned up too (was the only thing under it)
    expect(fs.existsSync(path.dirname(toolCallsDir))).toBe(false);
  });

  it("is a no-op when agentsRoot doesn't exist", () => {
    const result = sweepOverflow(path.join(tmp, "nope"));
    expect(result).toEqual({ removed: 0, bytes: 0 });
  });
});

describe("deleteSessionToolCalls", () => {
  it("removes the per-session tool-calls dir and cleans up the session shell", async () => {
    await fsp.mkdir(toolCallsDir, { recursive: true });
    fs.writeFileSync(path.join(toolCallsDir, "a.txt"), "data");
    deleteSessionToolCalls(path.join(tmp, "agents"), "a1", SESSION_ID);
    expect(fs.existsSync(toolCallsDir)).toBe(false);
    expect(fs.existsSync(path.dirname(toolCallsDir))).toBe(false);
  });

  it("is a no-op when the session has no tool-calls dir", () => {
    deleteSessionToolCalls(path.join(tmp, "agents"), "a1", "missing-session");
    // should not throw
  });
});
