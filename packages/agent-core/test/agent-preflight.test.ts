import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applySchema,
  createSessionStore,
  createMessageStore,
  createInboxStore,
} from "@openacme/db";
import { MemoryStore } from "@openacme/memory";
import { TaskStore } from "@openacme/tasks";
import type { ToolRegistry } from "@openacme/tools";
import type { UIMessage } from "ai";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/types.js";

const { streamTextMock, generateTextMock, getModelMock, getEffectiveContextWindowMock } =
  vi.hoisted(() => ({
    streamTextMock: vi.fn(),
    generateTextMock: vi.fn(),
    getModelMock: vi.fn(() => ({})),
    getEffectiveContextWindowMock: vi.fn<(config: unknown) => number | null>(
      () => null
    ),
  }));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: streamTextMock,
    generateText: generateTextMock,
  };
});

vi.mock("@openacme/llm-provider", () => ({
  getModel: getModelMock,
  getEffectiveContextWindow: getEffectiveContextWindowMock,
  supportsToolResultMedia: () => false,
}));

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

const stubToolRegistry = {
  get: () => undefined,
  // Return a deterministic tool blob so the estimator counts something.
  getVercelTools: () => ({ shell: { description: "shell tool" } }),
} as unknown as ToolRegistry;

function makeAgent(opts: {
  db: Database.Database;
  thresholdTokens: number | null;
  thresholdPercent?: number | null;
  contextWindow?: number | null;
  protectFirstN?: number;
  tailTokenBudget?: number;
}): Agent {
  const sessionStore = createSessionStore(opts.db);
  const messageStore = createMessageStore(opts.db);
  const config: AgentConfig = {
    id: "a1",
    name: "Agent A1",
    model: {
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "x",
      auth: "api_key",
      cacheTtl: "5m",
    },
    persona: "test",
    tools: ["shell"],
    maxSteps: 1,
    workspaceDir: "/tmp/openacme-preflight-test-ws",
    compression: {
      thresholdTokens: opts.thresholdTokens,
      thresholdPercent: opts.thresholdPercent ?? null,
      contextWindow: opts.contextWindow ?? null,
      protectFirstN: opts.protectFirstN ?? 1,
      tailTokenBudget: opts.tailTokenBudget ?? 200,
      summaryTargetRatio: 0.2,
      summarizerInputCharBudget: 80_000,
    },
  };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-preflight-test-"));
  return new Agent(config, {
    sessionStore,
    messageStore,
    toolRegistry: stubToolRegistry,
    attachmentsRoot: path.join(tmpRoot, "attachments"),
    memoryStore: new MemoryStore(path.join(tmpRoot, "agents")),
    taskStore: new TaskStore(path.join(tmpRoot, "tasks")),
    inboxStore: createInboxStore(opts.db),
  });
}

function bigUserMsg(id: string, charCount: number): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: "x".repeat(charCount) }],
  } as UIMessage;
}

function bigAssistantMsg(id: string, charCount: number): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "y".repeat(charCount) }],
  } as UIMessage;
}

describe("Agent.preflightCompress", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
    getModelMock.mockReset();
    getEffectiveContextWindowMock.mockReset();
    getModelMock.mockReturnValue({});
    // Summarizer aux model: any string output satisfies the pipeline.
    generateTextMock.mockResolvedValue({ text: "## Active Task\nNone." });
    // Default: no override — preflight uses config.contextWindow.
    getEffectiveContextWindowMock.mockReturnValue(null);
  });

  it("no-ops when compression config is missing", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "s1" });
    // makeAgent always sets compression — manually null it out.
    const agent = makeAgent({ db, thresholdTokens: null });
    (agent.config as { compression?: unknown }).compression = undefined;
    const newId = await agent.preflightCompress("s1", []);
    expect(newId).toBe("s1");
  });

  it("no-ops when threshold can't be resolved (no tokens and no percent+window)", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "s1" });
    const agent = makeAgent({
      db,
      thresholdTokens: null,
      thresholdPercent: null,
      contextWindow: null,
    });
    const newId = await agent.preflightCompress("s1", []);
    expect(newId).toBe("s1");
  });

  it("no-ops when history is under threshold", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const parent = sessions.create("a1", { id: "small" });

    const seed: UIMessage[] = [
      bigUserMsg("u1", 100),
      bigAssistantMsg("a1", 100),
    ];
    messages.appendMany(
      parent.id,
      seed.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        parts: m.parts,
      }))
    );

    const agent = makeAgent({
      db,
      // 10K-token threshold — seed is well under
      thresholdTokens: 10_000,
    });
    const newId = await agent.preflightCompress(parent.id, seed);
    expect(newId).toBe(parent.id);
    expect(sessions.findChildOf(parent.id)).toBeNull();
  });

  it("forks when history is over threshold and returns the child id", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const parent = sessions.create("a1", { id: "big" });

    // Seed enough messages to push the estimate over a 1K-token threshold.
    // Each user msg ~500 chars + each assistant ~500 chars = ~1000 chars
    // per turn ≈ 250 tokens per turn. 20 turns ≈ 5K tokens. Plus tools.
    const seed: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      seed.push(bigUserMsg(`u${i}`, 500));
      seed.push(bigAssistantMsg(`a${i}`, 500));
    }
    messages.appendMany(
      parent.id,
      seed.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        parts: m.parts,
      }))
    );

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const newId = await agent.preflightCompress(parent.id, seed);
    // Rename-swap: id is preserved; the active row at parent.id now
    // points back at the archived original.
    expect(newId).toBe(parent.id);
    const active = sessions.get(parent.id);
    expect(active?.parentSessionId).toBeTruthy();
    const archivedId = active!.parentSessionId!;
    expect(archivedId).not.toBe(parent.id);

    // Post-compaction history under the original id includes the
    // summary sentinel.
    const postHistory = messages.getHistory(parent.id);
    expect(postHistory.length).toBeGreaterThan(0);
    const hasSummary = postHistory.some((m) => {
      if (m.role !== "user") return false;
      const first = m.parts[0] as { type?: string; text?: string };
      return first.type === "text" && (first.text ?? "").includes("[CONTEXT COMPACTION");
    });
    expect(hasSummary).toBe(true);
  });

  it("uses the effective context window override when the 1M-latch is on", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const parent = sessions.create("a1", { id: "latched" });

    // Seed ~130K rough tokens (520K chars at chars/4): big enough to
    // cross 50% × 200K = 100K when the latch lowers the effective
    // window, but well UNDER 50% × 1M = 500K with the registry value.
    const seed: UIMessage[] = [];
    for (let i = 0; i < 13; i++) {
      seed.push(bigUserMsg(`u${i}`, 20_000));
      seed.push(bigAssistantMsg(`a${i}`, 20_000));
    }
    messages.appendMany(
      parent.id,
      seed.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        parts: m.parts,
      }))
    );

    // Latch ON: getEffectiveContextWindow returns 200K. Threshold becomes
    // 50% × 200K = 100K — seed (~130K) crosses it.
    getEffectiveContextWindowMock.mockReturnValue(200_000);

    const agent = makeAgent({
      db,
      thresholdTokens: null,
      thresholdPercent: 0.5,
      contextWindow: 1_000_000, // registry value — would normally give 500K threshold
      protectFirstN: 1,
      tailTokenBudget: 1_000,
    });

    const newId = await agent.preflightCompress(parent.id, seed);
    // Compaction fired (the active row now points at the archive).
    expect(newId).toBe(parent.id);
    expect(sessions.get(parent.id)?.parentSessionId).toBeTruthy();
    expect(getEffectiveContextWindowMock).toHaveBeenCalled();
  });

  it("does NOT fork the same session when the latch is OFF and 1M threshold isn't crossed", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const parent = sessions.create("a1", { id: "ok" });

    // Same seed as the latch test — ~130K rough tokens.
    const seed: UIMessage[] = [];
    for (let i = 0; i < 13; i++) {
      seed.push(bigUserMsg(`u${i}`, 20_000));
      seed.push(bigAssistantMsg(`a${i}`, 20_000));
    }
    messages.appendMany(
      parent.id,
      seed.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        parts: m.parts,
      }))
    );

    // Latch OFF: full 1M window in play. Threshold = 500K. 130K is well under.
    getEffectiveContextWindowMock.mockReturnValue(1_000_000);

    const agent = makeAgent({
      db,
      thresholdTokens: null,
      thresholdPercent: 0.5,
      contextWindow: 1_000_000,
      protectFirstN: 1,
      tailTokenBudget: 1_000,
    });

    const newId = await agent.preflightCompress(parent.id, seed);
    expect(newId).toBe(parent.id);
    // No compaction occurred — the active row did not get re-pointed.
    expect(sessions.get(parent.id)?.parentSessionId).toBeNull();
  });
});
