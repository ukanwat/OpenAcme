import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  applySchema,
  createSessionStore,
  createMessageStore,
  type Message,
} from "@openacme/db";
import type { ToolRegistry } from "@openacme/tools";
import { Agent } from "../src/agent.js";
import type { AgentConfig, StreamChunk } from "../src/types.js";

// Hoisted vi.fn() instances so we can rewrite their behavior per-test
// without re-importing modules. `streamText` and `generateText` from `ai`
// are mocked; `getModel` from llm-provider is stubbed to a sentinel — the
// SDK calls never reach a real provider.
const { streamTextMock, generateTextMock, getModelMock, APICallErrorMock } =
  vi.hoisted(() => {
    class APICallErrorMock extends Error {
      statusCode?: number;
      responseBody?: string;
      url = "";
      requestBodyValues = {};
      isRetryable = false;
      constructor(msg: string, status?: number, responseBody?: string) {
        super(msg);
        this.statusCode = status;
        this.responseBody = responseBody;
      }
      static isInstance(e: unknown): e is APICallErrorMock {
        return e instanceof APICallErrorMock;
      }
    }
    return {
      streamTextMock: vi.fn(),
      generateTextMock: vi.fn(),
      getModelMock: vi.fn(() => ({})),
      APICallErrorMock,
    };
  });

vi.mock("ai", () => ({
  streamText: streamTextMock,
  generateText: generateTextMock,
  // v5+ stop-condition factory; agent.ts imports it but the mocked streamText
  // ignores the value, so any sentinel works.
  stepCountIs: (n: number) => ({ kind: "step-count", count: n }),
  // The classifier imports APICallError statically — provide a stand-in
  // that satisfies `APICallError.isInstance(err)`.
  APICallError: APICallErrorMock,
}));

vi.mock("@openacme/llm-provider", () => ({
  getModel: getModelMock,
}));

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

const stubToolRegistry = {
  get: () => undefined,
  getVercelTools: () => ({}),
} as unknown as ToolRegistry;

interface StreamResultOpts {
  inputTokens?: number;
  text?: string;
}

function mockStreamResult(opts: StreamResultOpts = {}) {
  return {
    fullStream: (async function* () {
      // Empty — text-delta path isn't under test here.
    })(),
    usage: Promise.resolve({
      inputTokens: opts.inputTokens ?? 100,
      outputTokens: 10,
      totalTokens: (opts.inputTokens ?? 100) + 10,
    }),
    steps: Promise.resolve([
      { text: opts.text ?? "ok", toolCalls: [], toolResults: [] },
    ]),
  };
}

function failingStreamResult(error: unknown) {
  // Throw inside the for-await loop so the same code path that handles
  // network errors is exercised. Attach `.catch(() => {})` to the unawaited
  // promises so vitest doesn't flag them as unhandled rejections — the
  // agent code never reaches the `await result.usage` after fullStream
  // throws, but the rejected promises still exist.
  const usage = Promise.reject(error);
  const steps = Promise.reject(error);
  usage.catch(() => {});
  steps.catch(() => {});
  return {
    fullStream: (async function* () {
      throw error;
    })(),
    usage,
    steps,
  };
}

function makeAgent(opts: {
  db: Database.Database;
  thresholdTokens: number | null;
  protectFirstN?: number;
  tailTokenBudget?: number;
  summarizerModel?: AgentConfig["model"];
}): Agent {
  const sessionStore = createSessionStore(opts.db);
  const messageStore = createMessageStore(opts.db);
  const config: AgentConfig = {
    id: "a1",
    name: "Agent A1",
    model: { provider: "openai", model: "gpt-test", apiKey: "x" },
    persona: "test",
    tools: [],
    maxSteps: 1,
    compression: {
      thresholdTokens: opts.thresholdTokens,
      thresholdPercent: null,
      contextWindow: null,
      protectFirstN: opts.protectFirstN ?? 1,
      tailTokenBudget: opts.tailTokenBudget ?? 200,
      summaryTargetRatio: 0.2,
      summarizerInputCharBudget: 80_000,
      summarizerModel: opts.summarizerModel,
    },
  };
  return new Agent(config, {
    sessionStore,
    messageStore,
    toolRegistry: stubToolRegistry,
  });
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

function seedHistory(
  db: Database.Database,
  sessionId: string,
  pairs: Array<{ user: string; assistant: string }>
): void {
  const messages = createMessageStore(db);
  const rows: Array<Omit<Message, "id" | "createdAt">> = [];
  for (const p of pairs) {
    rows.push({
      sessionId,
      role: "user",
      content: p.user,
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });
    rows.push({
      sessionId,
      role: "assistant",
      content: p.assistant,
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });
  }
  messages.appendMany(sessionId, rows);
}

describe("Agent — proactive compression at end-of-turn", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
    getModelMock.mockReset();
    getModelMock.mockReturnValue({});
    generateTextMock.mockResolvedValue({ text: "## Active Task\nNone." });
  });

  it("forks at end of turn when usage > threshold; emits session before done", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);

    const parent = sessions.create("a1", { id: "parent" });
    seedHistory(db, parent.id, [
      { user: "u1", assistant: "a1" },
      { user: "u2", assistant: "a2" },
      { user: "u3", assistant: "a3" },
    ]);
    streamTextMock.mockReturnValue(mockStreamResult({ inputTokens: 5000 }));

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 100,
    });
    const chunks = await drain(agent.chat(parent.id, "next"));

    const sessionChunks = chunks.filter((c) => c.type === "session");
    const doneChunks = chunks.filter((c) => c.type === "done");
    expect(sessionChunks.length).toBe(1);
    expect(doneChunks.length).toBe(1);

    // session chunk must come before done.
    const sessionIdx = chunks.findIndex((c) => c.type === "session");
    const doneIdx = chunks.findIndex((c) => c.type === "done");
    expect(sessionIdx).toBeLessThan(doneIdx);

    const childId = (sessionChunks[0] as { sessionId: string }).sessionId;
    expect(childId).not.toBe(parent.id);
    const child = sessions.get(childId);
    expect(child?.parentSessionId).toBe(parent.id);

    // Child has [head (protectFirstN=1 → first user msg), summary,
    // ...pre-pruned tail, user_new, assistant_response]. Summary lives
    // somewhere in the middle; locate it by scanning.
    const childHistory = messages.getHistory(childId);
    const summaryRow = childHistory.find((m) =>
      m.content?.includes("[CONTEXT COMPACTION")
    );
    expect(summaryRow).toBeDefined();
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("does not fork below threshold", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "s1" });
    streamTextMock.mockReturnValue(mockStreamResult({ inputTokens: 50 }));

    const agent = makeAgent({ db, thresholdTokens: 1000 });
    const chunks = await drain(agent.chat("s1", "hi"));

    expect(chunks.filter((c) => c.type === "session").length).toBe(0);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(sessions.findChildOf("s1")).toBeNull();
  });

  it("does not fork when threshold is null", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "s1" });
    streamTextMock.mockReturnValue(mockStreamResult({ inputTokens: 999_999 }));

    const agent = makeAgent({ db, thresholdTokens: null });
    const chunks = await drain(agent.chat("s1", "hi"));

    expect(chunks.filter((c) => c.type === "session").length).toBe(0);
    expect(sessions.findChildOf("s1")).toBeNull();
  });

  it("iterative summary: second compression includes the first summary in prompt", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "p1" });
    seedHistory(db, "p1", [
      { user: "u1", assistant: "a1" },
      { user: "u2", assistant: "a2" },
      { user: "u3", assistant: "a3" },
    ]);

    streamTextMock.mockReturnValue(mockStreamResult({ inputTokens: 5000 }));
    generateTextMock.mockResolvedValueOnce({
      text: "## Active Task\nFIRST_SUMMARY_BODY",
    });

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 100,
    });
    const chunks1 = await drain(agent.chat("p1", "msg1"));
    const childId = (
      chunks1.find((c) => c.type === "session") as { sessionId: string }
    ).sessionId;

    // Seed extra history on the child to have something compressible.
    seedHistory(db, childId, [
      { user: "u4", assistant: "a4" },
      { user: "u5", assistant: "a5" },
    ]);

    streamTextMock.mockReturnValue(mockStreamResult({ inputTokens: 8000 }));
    generateTextMock.mockResolvedValueOnce({
      text: "## Active Task\nSECOND_SUMMARY_BODY",
    });

    await drain(agent.chat(childId, "msg2"));

    // Second summarizer call (the one for the child's compression) should
    // see "PREVIOUS SUMMARY:" in its prompt.
    const secondCall = generateTextMock.mock.calls[1];
    expect(secondCall).toBeDefined();
    const secondPrompt = secondCall![0].prompt as string;
    expect(secondPrompt).toContain("PREVIOUS SUMMARY:");
    expect(secondPrompt).toContain("FIRST_SUMMARY_BODY");
  });
});

describe("Agent — reactive compression on provider errors", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
    getModelMock.mockReset();
    getModelMock.mockReturnValue({});
    generateTextMock.mockResolvedValue({ text: "## Active Task\nNone." });
  });

  it("recovers from 413 by compressing and retrying once", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "p1" });
    seedHistory(db, "p1", [
      { user: "u1", assistant: "a1" },
      { user: "u2", assistant: "a2" },
      { user: "u3", assistant: "a3" },
    ]);

    streamTextMock
      .mockReturnValueOnce(failingStreamResult(new APICallErrorMock("413", 413)))
      .mockReturnValueOnce(mockStreamResult({ inputTokens: 200 }));

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 100,
    });
    const chunks = await drain(agent.chat("p1", "msg"));

    const sessionChunks = chunks.filter((c) => c.type === "session");
    expect(sessionChunks.length).toBe(1);
    const doneChunks = chunks.filter((c) => c.type === "done");
    expect(doneChunks.length).toBe(1);
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("recovers from context_overflow via responseBody pattern", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "p1" });
    seedHistory(db, "p1", [
      { user: "u1", assistant: "a1" },
      { user: "u2", assistant: "a2" },
      { user: "u3", assistant: "a3" },
    ]);

    streamTextMock
      .mockReturnValueOnce(
        failingStreamResult(
          new APICallErrorMock(
            "bad request",
            400,
            JSON.stringify({ error: "this prompt is too long for the model" })
          )
        )
      )
      .mockReturnValueOnce(mockStreamResult({ inputTokens: 200 }));

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 100,
    });
    const chunks = await drain(agent.chat("p1", "msg"));

    expect(chunks.filter((c) => c.type === "session").length).toBe(1);
    expect(chunks.filter((c) => c.type === "done").length).toBe(1);
  });

  it("two consecutive 413s surface as a final error chunk (no third attempt)", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "p1" });
    seedHistory(db, "p1", [
      { user: "u1", assistant: "a1" },
      { user: "u2", assistant: "a2" },
      { user: "u3", assistant: "a3" },
    ]);

    streamTextMock.mockReturnValue(
      failingStreamResult(new APICallErrorMock("413", 413))
    );

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 100,
    });
    const chunks = await drain(agent.chat("p1", "msg"));

    expect(chunks.filter((c) => c.type === "done").length).toBe(0);
    expect(chunks.filter((c) => c.type === "error").length).toBe(1);
    // Two attempts, no more.
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("non-recoverable error (auth 401) surfaces without compression", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "p1" });

    streamTextMock.mockReturnValue(
      failingStreamResult(new APICallErrorMock("Unauthorized", 401))
    );

    const agent = makeAgent({ db, thresholdTokens: 1000 });
    const chunks = await drain(agent.chat("p1", "msg"));

    expect(chunks.filter((c) => c.type === "error").length).toBe(1);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });
});

describe("Agent — anti-thrashing & cooldown", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
    getModelMock.mockReset();
    getModelMock.mockReturnValue({});
  });

  it("anti-thrash: skips compression after 2 consecutive low-savings forks", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "p1" });
    seedHistory(db, "p1", [
      { user: "u1", assistant: "a1" },
      { user: "u2", assistant: "a2" },
      { user: "u3", assistant: "a3" },
    ]);

    // generateText returns a HUGE summary so child won't be smaller than parent.
    const huge = "X".repeat(1_000_000);
    generateTextMock.mockResolvedValue({ text: huge });
    streamTextMock.mockReturnValue(mockStreamResult({ inputTokens: 5000 }));

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 100,
    });

    // Turn 1: compresses (savings ratio low, ~0).
    const c1 = await drain(agent.chat("p1", "m1"));
    const child1Id =
      (c1.find((c) => c.type === "session") as { sessionId: string }).sessionId;

    // Seed the child with more history so it's compressible again.
    seedHistory(db, child1Id, [
      { user: "u4", assistant: "a4" },
      { user: "u5", assistant: "a5" },
    ]);

    // Turn 2: compresses again (still low savings).
    const c2 = await drain(agent.chat(child1Id, "m2"));
    const child2Id =
      (c2.find((c) => c.type === "session") as { sessionId: string }).sessionId;

    // Seed AGAIN.
    seedHistory(db, child2Id, [
      { user: "u6", assistant: "a6" },
      { user: "u7", assistant: "a7" },
    ]);

    // Turn 3: should NOT compress (anti-thrash kicks in after 2 consecutive
    // <10% savings). Verify by counting generateText calls.
    const callsBefore = generateTextMock.mock.calls.length;
    const c3 = await drain(agent.chat(child2Id, "m3"));
    const callsAfter = generateTextMock.mock.calls.length;

    expect(callsAfter).toBe(callsBefore); // No new summarizer call.
    expect(c3.filter((c) => c.type === "session").length).toBe(0);
  });

  it("cooldown: first summarizer failure sets a cooldown that blocks immediate retry", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "p1" });
    seedHistory(db, "p1", [
      { user: "u1", assistant: "a1" },
      { user: "u2", assistant: "a2" },
      { user: "u3", assistant: "a3" },
    ]);

    streamTextMock.mockReturnValue(mockStreamResult({ inputTokens: 5000 }));
    generateTextMock.mockRejectedValue(new Error("500 internal error"));

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 100,
    });

    // Turn 1: summarizer fails → no fork, parent stays.
    const c1 = await drain(agent.chat("p1", "m1"));
    expect(c1.filter((c) => c.type === "session").length).toBe(0);
    expect(sessions.findChildOf("p1")).toBeNull();
    const callsAfter1 = generateTextMock.mock.calls.length;

    // Turn 2 immediately: cooldown should block summarizer call.
    const c2 = await drain(agent.chat("p1", "m2"));
    expect(c2.filter((c) => c.type === "session").length).toBe(0);
    expect(generateTextMock.mock.calls.length).toBe(callsAfter1); // No new call.
  });
});

describe("Agent — aux model fallback", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
    getModelMock.mockReset();
    getModelMock.mockReturnValue({});
  });

  it("falls back from configured summarizerModel to main model on aux failure", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "p1" });
    seedHistory(db, "p1", [
      { user: "u1", assistant: "a1" },
      { user: "u2", assistant: "a2" },
      { user: "u3", assistant: "a3" },
    ]);

    streamTextMock.mockReturnValue(mockStreamResult({ inputTokens: 5000 }));
    // First call (aux model) fails; second call (main fallback) succeeds.
    generateTextMock
      .mockRejectedValueOnce(new Error("model not found"))
      .mockResolvedValueOnce({ text: "## Active Task\nNone." });

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 100,
      summarizerModel: {
        provider: "openai",
        model: "missing-model",
        apiKey: "x",
      },
    });

    const chunks = await drain(agent.chat("p1", "msg"));
    expect(chunks.filter((c) => c.type === "session").length).toBe(1);
    expect(chunks.filter((c) => c.type === "done").length).toBe(1);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });
});
