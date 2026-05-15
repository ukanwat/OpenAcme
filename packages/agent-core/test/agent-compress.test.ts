import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applySchema, createSessionStore, createMessageStore } from "@openacme/db";
import { MemoryStore } from "@openacme/memory";
import { TaskStore } from "@openacme/tasks";
import type { ToolRegistry } from "@openacme/tools";
import type { UIMessage } from "ai";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/types.js";

// `streamText` and `generateText` from `ai` are mocked. The agent's
// `runStream` returns whatever `streamText` returns; for our tests that's
// a stub object with a `usage` Promise — we don't drive the fullStream
// loop here, that's the host's job.
const { streamTextMock, generateTextMock, getModelMock } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
  generateTextMock: vi.fn(),
  getModelMock: vi.fn(() => ({})),
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

function makeAgent(opts: {
  db: Database.Database;
  thresholdTokens: number | null;
  protectFirstN?: number;
  tailTokenBudget?: number;
  attachmentsRoot?: string;
}): Agent {
  const sessionStore = createSessionStore(opts.db);
  const messageStore = createMessageStore(opts.db);
  const config: AgentConfig = {
    id: "a1",
    name: "Agent A1",
    model: { provider: "openai", model: "gpt-test", apiKey: "x", auth: "api_key" },
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
    },
  };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-core-test-"));
  return new Agent(config, {
    sessionStore,
    messageStore,
    toolRegistry: stubToolRegistry,
    attachmentsRoot: opts.attachmentsRoot ?? "/tmp/openacme-test-attachments",
    memoryStore: new MemoryStore(path.join(tmpRoot, "agents")),
    taskStore: new TaskStore(path.join(tmpRoot, "tasks")),
  });
}

function userUI(text: string): UIMessage {
  return {
    id: `u-${text}`,
    role: "user",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

function assistantUI(text: string): UIMessage {
  return {
    id: `a-${text}`,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("Agent — compress() over UIMessage[]", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
    getModelMock.mockReset();
    getModelMock.mockReturnValue({});
    generateTextMock.mockResolvedValue({ text: "## Active Task\nNone." });
  });

  it("noOp on short history (below protectFirstN + minTail threshold)", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "s1" });
    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 100,
    });
    // Seed an empty history so compress sees nothing to summarize.
    const childId = await agent.compress("s1", "proactive");
    // No-op → caller sees parent id back.
    expect(childId).toBe("s1");
    expect(sessions.findChildOf("s1")).toBeNull();
  });

  it("forks the session when there's enough history to summarize", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const parent = sessions.create("a1", { id: "parent" });

    // Seed a long-enough conversation.
    const seed: UIMessage[] = [];
    for (let i = 0; i < 6; i++) {
      seed.push(userUI(`u${i}`));
      seed.push(assistantUI(`a${i}`.repeat(40)));
    }
    messages.appendMany(
      parent.id,
      seed.map((m) => ({ id: m.id, role: m.role as "user" | "assistant", parts: m.parts }))
    );

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 100,
    });
    const childId = await agent.compress(parent.id, "proactive");
    expect(childId).not.toBe(parent.id);
    const child = sessions.get(childId);
    expect(child?.parentSessionId).toBe(parent.id);

    const childHistory = messages.getHistory(childId);
    expect(childHistory.length).toBeGreaterThan(0);
    // The synthetic summary shows up as a user message whose first text-part
    // begins with the SUMMARY_PREFIX sentinel.
    const summaryRow = childHistory.find((m) => {
      if (m.role !== "user") return false;
      const first = m.parts[0] as { type?: string; text?: string };
      return first.type === "text" && (first.text ?? "").includes("[CONTEXT COMPACTION");
    });
    expect(summaryRow).toBeDefined();
  });

  it("returns the existing child when one already exists for the parent", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const parent = sessions.create("a1", { id: "p" });
    const existingChild = sessions.createChildIfNoSibling("a1", parent.id);
    expect(existingChild).not.toBeNull();

    const agent = makeAgent({ db, thresholdTokens: 1000 });
    const childId = await agent.compress(parent.id, "proactive");
    expect(childId).toBe(existingChild!.id);
  });

  it("preserves user FileUIParts across the fork; rewrites URL to child + copies bytes", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-att-"));
    const root = path.join(tmp, "attachments");
    const parent = sessions.create("a1", { id: "parent" });

    // Stage one image under the parent's session dir.
    const rel = `${parent.id}/att-seed/shot.png`;
    fs.mkdirSync(path.join(root, `${parent.id}/att-seed`), { recursive: true });
    fs.writeFileSync(
      path.join(root, rel),
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );

    const userWithFile: UIMessage = {
      id: "u-file",
      role: "user",
      parts: [
        { type: "text", text: "what's in this?" },
        {
          type: "file",
          url: `/api/attachments/${rel}`,
          mediaType: "image/png",
          filename: "shot.png",
        },
      ],
    } as UIMessage;

    // Seed enough turns to trigger compression.
    const seed: UIMessage[] = [userWithFile];
    for (let i = 0; i < 6; i++) {
      seed.push(assistantUI(`a${i}`.repeat(40)));
      seed.push(userUI(`u${i}`));
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
      tailTokenBudget: 100,
      attachmentsRoot: root,
    });
    const childId = await agent.compress(parent.id, "proactive");
    expect(childId).not.toBe(parent.id);

    // Find the head copy of the user-with-file in the child. It should
    // carry a FileUIPart whose URL is now under the CHILD session dir,
    // and the file should exist at the new path on disk.
    const childHistory = messages.getHistory(childId);
    const childUserParts = childHistory
      .filter((m) => m.role === "user")
      .flatMap((m) => m.parts as Array<{ type?: string; url?: string }>);
    const fileParts = childUserParts.filter((p) => p.type === "file");
    expect(fileParts.length).toBeGreaterThan(0);
    for (const fp of fileParts) {
      expect(fp.url).toBeDefined();
      expect(fp.url!.startsWith(`/api/attachments/${childId}/`)).toBe(true);
      const childRel = fp.url!.slice("/api/attachments/".length);
      expect(fs.existsSync(path.join(root, childRel))).toBe(true);
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("counts FileUIParts at IMAGE_CHAR_EQUIVALENT in the boundary walker", async () => {
    // Without originalParts the budget would only see the `[file: ...]` text
    // marker (~30 chars) and let the message stay in the tail. With
    // originalParts the file-part contributes ~6400 chars and a long-enough
    // history actually triggers compression on multi-image turns.
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const parent = sessions.create("a1", { id: "p-img" });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-img-"));
    const root = path.join(tmp, "attachments");

    // 12 turns, each user with 2 images. With proper budget weighting the
    // walker will pull the boundary inward; without it, almost everything
    // fits in the tail.
    const seed: UIMessage[] = [];
    for (let i = 0; i < 12; i++) {
      seed.push({
        id: `u-${i}`,
        role: "user",
        parts: [
          { type: "text", text: `q${i}` },
          {
            type: "file",
            url: `/api/attachments/external/_/img${i}.png`,
            mediaType: "image/png",
            filename: `img${i}.png`,
          },
          {
            type: "file",
            url: `/api/attachments/external/_/img${i}b.png`,
            mediaType: "image/png",
            filename: `img${i}b.png`,
          },
        ],
      } as UIMessage);
      seed.push(assistantUI(`a${i}`));
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
      attachmentsRoot: root,
    });
    const childId = await agent.compress(parent.id, "proactive");
    // Compression actually fires (no-op would return parent id).
    expect(childId).not.toBe(parent.id);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("Agent — runStream + attachments inlining", () => {
  it("reads attachment bytes off disk for FileUIPart URLs", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const session = sessions.create("a1", { id: "s1" });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-att-"));
    const root = path.join(tmp, "attachments");
    const rel = `${session.id}/att-1/shot.png`;
    fs.mkdirSync(path.join(root, `${session.id}/att-1`), { recursive: true });
    fs.writeFileSync(path.join(root, rel), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    streamTextMock.mockReturnValue({
      fullStream: (async function* () {})(),
      usage: Promise.resolve({}),
      response: Promise.resolve({ messages: [] }),
    });

    const agent = makeAgent({
      db,
      thresholdTokens: null,
      attachmentsRoot: root,
    });
    const userMsg: UIMessage = {
      id: "u1",
      role: "user",
      parts: [
        { type: "text", text: "what's in this?" } as UIMessage["parts"][number],
        {
          type: "file",
          url: `/api/attachments/${rel}`,
          mediaType: "image/png",
          filename: "shot.png",
        } as unknown as UIMessage["parts"][number],
      ],
    } as UIMessage;
    await agent.runStream({ sessionId: session.id, history: [userMsg] });
    // streamText should have been called with messages containing the
    // image bytes inlined as a data: URL (not the local /api path).
    const arg = streamTextMock.mock.calls[0]![0]!;
    const messages = arg.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const userModelMsg = messages.find((m) => m.role === "user");
    const partsOrText = userModelMsg!.content;
    const serialized = JSON.stringify(partsOrText);
    expect(serialized).toContain("data:image/png;base64,");
    expect(serialized).not.toContain("/api/attachments/");

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
