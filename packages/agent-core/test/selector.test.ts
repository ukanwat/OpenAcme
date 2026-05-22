import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  applySchema,
  createSessionStore,
  createMessageStore,
  createInboxStore,
} from "@openacme/db";
import { MemoryStore } from "@openacme/memory";
import { TaskStore } from "@openacme/tasks";
import type { ToolRegistry } from "@openacme/tools";
import { MockLanguageModelV3 } from "ai/test";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/types.js";
import { findRelevantMemories } from "../src/selector.js";

// Selector now goes through `runSubagent({mode:"structured"})`, which
// uses `getModel(parent.config.model)`. Mock the llm-provider module
// so each test can swap in a controlled MockLanguageModelV3 without
// having to wire real provider config.
const { getModelMock } = vi.hoisted(() => ({
  getModelMock: vi.fn<(cfg: unknown) => unknown>(() => ({})),
}));
vi.mock("@openacme/llm-provider", () => ({
  getModel: getModelMock,
  supportsToolResultMedia: () => false,
}));

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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-sel-agent-"));
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
  };
  return new Agent(config, {
    sessionStore,
    messageStore,
    toolRegistry: stubToolRegistry,
    attachmentsRoot: path.join(tmpRoot, "att"),
    memoryStore: new MemoryStore(path.join(tmpRoot, "agents")),
    taskStore: new TaskStore(path.join(tmpRoot, "tasks")),
    inboxStore: createInboxStore(db),
  });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openacme-selector-"));
}

function write(dir: string, rel: string, body: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf-8");
  return abs;
}

function entry(desc: string, body = "content"): string {
  return `---\nname: x\ndescription: ${desc}\n---\n\n${body}`;
}

/** Mock that returns a fixed JSON object for generateObject. */
function modelReturning(selected: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ selected_memories: selected }),
        },
      ],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  });
}

/** Mock that throws if called — used to assert "no model call happened." */
function modelThatMustNotBeCalled(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("selector unexpectedly called the model");
    },
  });
}

describe("findRelevantMemories", () => {
  let dir: string;
  let agent: Agent;

  beforeEach(() => {
    dir = tmpDir();
    agent = makeAgent();
    getModelMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] without a model call when memory dir is empty", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const model = modelThatMustNotBeCalled();
    getModelMock.mockReturnValue(model);
    const out = await findRelevantMemories({
      parent: agent,
      triggerText: "anything",
      memoryDir: dir,
    });
    expect(out).toEqual([]);
    expect(model.doGenerateCalls.length).toBe(0);
  });

  it("returns [] without a model call when every entry is already surfaced", async () => {
    const a = write(dir, "a.md", entry("a hook"));
    const b = write(dir, "b.md", entry("b hook"));
    const model = modelThatMustNotBeCalled();
    getModelMock.mockReturnValue(model);
    const out = await findRelevantMemories({
      parent: agent,
      triggerText: "anything",
      memoryDir: dir,
      alreadySurfaced: new Set([a, b]),
    });
    expect(out).toEqual([]);
    expect(model.doGenerateCalls.length).toBe(0);
  });

  it("filters alreadySurfaced before the model call (only fresh names visible in prompt)", async () => {
    const a = write(dir, "a.md", entry("a hook"));
    write(dir, "b.md", entry("b hook"));
    const model = modelReturning(["b.md"]);
    getModelMock.mockReturnValue(model);
    await findRelevantMemories({
      parent: agent,
      triggerText: "trigger",
      memoryDir: dir,
      alreadySurfaced: new Set([a]),
    });
    expect(model.doGenerateCalls.length).toBe(1);
    const call = model.doGenerateCalls[0]!;
    const userText = JSON.stringify(call.prompt);
    expect(userText).toContain("b.md");
    expect(userText).not.toContain("a.md");
  });

  it("returns selected entries with absolute paths and mtime", async () => {
    const a = write(dir, "a.md", entry("a hook"));
    write(dir, "b.md", entry("b hook"));
    getModelMock.mockReturnValue(modelReturning(["a.md"]));
    const out = await findRelevantMemories({
      parent: agent,
      triggerText: "trigger",
      memoryDir: dir,
    });
    expect(out.length).toBe(1);
    expect(out[0]!.path).toBe(a);
    expect(typeof out[0]!.mtimeMs).toBe("number");
  });

  it("drops invalid filenames from the model selection", async () => {
    write(dir, "real.md", entry("hook"));
    getModelMock.mockReturnValue(modelReturning(["real.md", "hallucinated.md"]));
    const out = await findRelevantMemories({
      parent: agent,
      triggerText: "trigger",
      memoryDir: dir,
    });
    expect(out.map((m) => path.basename(m.path))).toEqual(["real.md"]);
  });

  it("caps the result at 5 even when the selector returns more", async () => {
    const names = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md"];
    for (const n of names) write(dir, n, entry(`${n} hook`));
    getModelMock.mockReturnValue(modelReturning(names));
    const out = await findRelevantMemories({
      parent: agent,
      triggerText: "trigger",
      memoryDir: dir,
    });
    expect(out.length).toBe(5);
  });

  it("includes the recent-tools section when provided", async () => {
    write(dir, "x.md", entry("hook"));
    const model = modelReturning([]);
    getModelMock.mockReturnValue(model);
    await findRelevantMemories({
      parent: agent,
      triggerText: "trigger",
      memoryDir: dir,
      recentTools: ["shell", "read_file"],
    });
    const userText = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(userText).toContain("Recently used tools: shell, read_file");
  });

  it("omits the recent-tools section when empty", async () => {
    write(dir, "x.md", entry("hook"));
    const model = modelReturning([]);
    getModelMock.mockReturnValue(model);
    await findRelevantMemories({
      parent: agent,
      triggerText: "trigger",
      memoryDir: dir,
      recentTools: [],
    });
    const userText = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(userText).not.toContain("Recently used tools");
  });

  it("passes triggerText through unchanged (source-opaque)", async () => {
    write(dir, "x.md", entry("hook"));
    const model = modelReturning([]);
    getModelMock.mockReturnValue(model);
    await findRelevantMemories({
      parent: agent,
      triggerText: "from a synthetic peer message at 2026-05-11T00:00",
      memoryDir: dir,
    });
    const userText = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(userText).toContain("from a synthetic peer message at 2026-05-11T00:00");
  });

  it("returns [] when the model errors", async () => {
    write(dir, "x.md", entry("hook"));
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("model down");
      },
    });
    getModelMock.mockReturnValue(model);
    const out = await findRelevantMemories({
      parent: agent,
      triggerText: "trigger",
      memoryDir: dir,
    });
    expect(out).toEqual([]);
  });
});
