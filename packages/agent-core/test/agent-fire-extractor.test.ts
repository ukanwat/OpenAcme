import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  applySchema,
  createSessionStore,
  createMessageStore,
} from "@openacme/db";
import { MemoryStore } from "@openacme/memory";
import { TaskStore } from "@openacme/tasks";
import type { ToolRegistry } from "@openacme/tools";
import type { UIMessage } from "ai";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/types.js";
import * as extractorModule from "../src/extractor.js";

const stubToolRegistry = {
  get: () => undefined,
  getVercelTools: () => ({}),
} as unknown as ToolRegistry;

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function makeAgent(): Agent {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "openacme-fire-extractor-")
  );
  const db = freshDb();
  const sessionStore = createSessionStore(db);
  const messageStore = createMessageStore(db);
  const config: AgentConfig = {
    id: "a1",
    name: "A1",
    model: {
      provider: "openai",
      model: "test",
      apiKey: "x",
      auth: "api_key",
    },
    persona: "test",
    tools: [],
    maxSteps: 1,
    memoryCharLimit: 2200,
  };
  return new Agent(config, {
    sessionStore,
    messageStore,
    toolRegistry: stubToolRegistry,
    attachmentsRoot: path.join(tmpRoot, "att"),
    memoryStore: new MemoryStore(path.join(tmpRoot, "agents")),
    taskStore: new TaskStore(path.join(tmpRoot, "tasks")),
  });
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function asst(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

/**
 * Drive `fireExtractor` and wait for the underlying promise to settle.
 * The method is fire-and-forget; tests need to await the inner work to
 * make assertions about cursor / in-progress state.
 */
async function fireAndSettle(
  agent: Agent,
  args: Parameters<Agent["fireExtractor"]>[0]
): Promise<void> {
  agent.fireExtractor(args);
  // Yield enough microtasks for the promise chain to settle. The
  // extractor's own work is mocked to return synchronously, so a few
  // microtask ticks are sufficient.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("Agent.fireExtractor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes the extractor with the full session messages and a positive newMessageCount", async () => {
    const agent = makeAgent();
    const spy = vi
      .spyOn(extractorModule, "runExtractor")
      .mockResolvedValue({ status: "completed" });

    const messages = [user("u1", "hi"), asst("a1", "ok")];
    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: messages,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0];
    expect(call.sessionId).toBe("s1");
    expect(call.sessionMessages).toBe(messages);
    expect(call.newMessageCount).toBe(2); // first run, no cursor → all
  });

  it("advances the cursor past the last assistant on completed", async () => {
    const agent = makeAgent();
    vi.spyOn(extractorModule, "runExtractor").mockResolvedValue({
      status: "completed",
    });

    const round1 = [user("u1", "hi"), asst("a1", "ok")];
    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: round1,
    });

    // Second fire on the SAME messages → no new content past the cursor
    // → fireExtractor should bail without calling runExtractor again.
    const spy = vi.spyOn(extractorModule, "runExtractor");
    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: round1,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("counts new messages strictly after the cursor on subsequent fires", async () => {
    const agent = makeAgent();
    vi.spyOn(extractorModule, "runExtractor").mockResolvedValue({
      status: "completed",
    });
    const round1 = [user("u1", "hi"), asst("a1", "ok")];
    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: round1,
    });

    const spy = vi
      .spyOn(extractorModule, "runExtractor")
      .mockResolvedValue({ status: "completed" });
    const round2 = [...round1, user("u2", "more"), asst("a2", "noted")];
    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: round2,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].newMessageCount).toBe(2);
  });

  it("does NOT advance the cursor on failed status (next fire retries the window)", async () => {
    const agent = makeAgent();
    vi.spyOn(extractorModule, "runExtractor").mockResolvedValueOnce({
      status: "failed",
      error: "boom",
    });
    const messages = [user("u1", "hi"), asst("a1", "ok")];
    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: messages,
    });

    // Cursor unchanged; second fire on the same messages should still run.
    const spy = vi
      .spyOn(extractorModule, "runExtractor")
      .mockResolvedValue({ status: "completed" });
    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: messages,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("advances the cursor on skipped-main-wrote (work is covered)", async () => {
    const agent = makeAgent();
    vi.spyOn(extractorModule, "runExtractor").mockResolvedValueOnce({
      status: "skipped-main-wrote",
    });
    const messages = [user("u1", "hi"), asst("a1", "ok")];
    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: messages,
    });

    // Second fire with the same range bails without invoking the extractor.
    const spy = vi.spyOn(extractorModule, "runExtractor");
    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: messages,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("drops re-entrant fires while one is in progress (no parallel forks)", async () => {
    const agent = makeAgent();
    let resolveFirst!: (v: { status: "completed" }) => void;
    const firstPromise = new Promise<{ status: "completed" }>((r) => {
      resolveFirst = r;
    });
    const spy = vi
      .spyOn(extractorModule, "runExtractor")
      .mockImplementation(() => firstPromise);

    const messages = [user("u1", "hi"), asst("a1", "ok")];
    agent.fireExtractor({ sessionId: "s1", sessionMessages: messages });
    // Second fire while first is still pending → should be dropped.
    agent.fireExtractor({ sessionId: "s1", sessionMessages: messages });
    expect(spy).toHaveBeenCalledTimes(1);

    // Let the first finish; the in-progress flag clears.
    resolveFirst({ status: "completed" });
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // After completion + cursor advance, third fire on same messages bails
    // (no new content), but the in-progress guard is no longer in the way.
    const spy2 = vi.spyOn(extractorModule, "runExtractor");
    agent.fireExtractor({ sessionId: "s1", sessionMessages: messages });
    expect(spy2).not.toHaveBeenCalled();
  });

  it("does not bail when the cursor is stale (post-compaction)", async () => {
    const agent = makeAgent();
    // Set a cursor for a message that no longer exists in the session
    // (e.g. compaction dropped the assistant message id we cached).
    vi.spyOn(extractorModule, "runExtractor").mockResolvedValue({
      status: "completed",
    });
    const initialMessages = [user("u1", "hi"), asst("a1-old", "before compaction")];
    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: initialMessages,
    });

    // Compaction has produced a fresh history with new ids.
    const spy = vi
      .spyOn(extractorModule, "runExtractor")
      .mockResolvedValue({ status: "completed" });
    const compacted = [user("u2", "later"), asst("a2", "noted")];
    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: compacted,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    // Stale cursor → countMessagesAfter falls back to full length.
    expect(spy.mock.calls[0]![0].newMessageCount).toBe(2);
  });

  it("isolates cursors per session", async () => {
    const agent = makeAgent();
    vi.spyOn(extractorModule, "runExtractor").mockResolvedValue({
      status: "completed",
    });

    const m1 = [user("u1", "s1"), asst("a1", "s1-ok")];
    await fireAndSettle(agent, { sessionId: "s1", sessionMessages: m1 });

    const spy = vi
      .spyOn(extractorModule, "runExtractor")
      .mockResolvedValue({ status: "completed" });
    const m2 = [user("u2", "s2"), asst("a2", "s2-ok")];
    await fireAndSettle(agent, { sessionId: "s2", sessionMessages: m2 });
    // Different session → no cursor → fires.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].sessionId).toBe("s2");
  });
});
