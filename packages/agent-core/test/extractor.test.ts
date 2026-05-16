import { describe, it, expect, vi, beforeEach } from "vitest";
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
import type { UIMessage } from "ai";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/types.js";
import { hasMemoryWritesIn, runExtractor } from "../src/extractor.js";
import * as subagentModule from "../src/subagent.js";

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
    path.join(os.tmpdir(), "openacme-extractor-")
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

function asst(parts: unknown[]): UIMessage {
  return {
    id: `m-${Math.random()}`,
    role: "assistant",
    parts: parts as UIMessage["parts"],
  };
}

function user(text: string): UIMessage {
  return {
    id: `u-${Math.random()}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

describe("hasMemoryWritesIn", () => {
  it("false on empty", () => {
    expect(hasMemoryWritesIn([])).toBe(false);
  });

  it("false when no memory tool calls present", () => {
    expect(
      hasMemoryWritesIn([
        user("hi"),
        asst([
          { type: "text", text: "hello" },
          {
            type: "tool-shell",
            state: "output-available",
            input: { command: "ls" },
            output: "",
          },
        ]),
      ])
    ).toBe(false);
  });

  it("false on read-only memory ops (view/delete/rename)", () => {
    expect(
      hasMemoryWritesIn([
        asst([
          {
            type: "tool-memory",
            state: "output-available",
            input: { command: "view", path: "/memories" },
          },
          {
            type: "tool-memory",
            state: "output-available",
            input: { command: "delete", path: "/memories/x.md" },
          },
          {
            type: "tool-memory",
            state: "output-available",
            input: { command: "rename", old_path: "/m/a", new_path: "/m/b" },
          },
        ]),
      ])
    ).toBe(false);
  });

  it("true on create / str_replace / insert", () => {
    for (const cmd of ["create", "str_replace", "insert"]) {
      expect(
        hasMemoryWritesIn([
          asst([
            {
              type: "tool-memory",
              state: "output-available",
              input: { command: cmd },
            },
          ]),
        ])
      ).toBe(true);
    }
  });

  it("ignores in-flight memory tool parts (input-streaming/input-available before output)", () => {
    // The user tests above use input-available with a result already
    // present (full output). For a pure "in-flight, no output yet" we
    // model `input-streaming` — the convention is unconfirmed until the
    // SDK emits output-available.
    expect(
      hasMemoryWritesIn([
        asst([
          {
            type: "tool-memory",
            state: "input-streaming",
            input: { command: "create" },
          },
        ]),
      ])
    ).toBe(false);
  });

  it("ignores user messages (only assistant turns can call tools)", () => {
    expect(
      hasMemoryWritesIn([
        {
          id: "u",
          role: "user",
          parts: [
            {
              // shape that would match if we didn't role-gate
              type: "tool-memory",
              state: "output-available",
              input: { command: "create" },
            } as unknown as UIMessage["parts"][number],
          ],
        },
      ])
    ).toBe(false);
  });
});

describe("runExtractor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns skipped-no-new-content when newMessageCount is 0", async () => {
    const agent = makeAgent();
    const spy = vi.spyOn(subagentModule, "runSubagent");
    const out = await runExtractor({
      agent,
      sessionId: "s1",
      sessionMessages: [],
      newMessageCount: 0,
    });
    expect(out.status).toBe("skipped-no-new-content");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns skipped-main-wrote when main agent already wrote a memory", async () => {
    const agent = makeAgent();
    const spy = vi.spyOn(subagentModule, "runSubagent");
    const out = await runExtractor({
      agent,
      sessionId: "s1",
      sessionMessages: [
        user("save my preference"),
        asst([
          {
            type: "tool-memory",
            state: "output-available",
            input: { command: "create", path: "/memories/x.md", file_text: "..." },
          },
        ]),
      ],
      newMessageCount: 2,
    });
    expect(out.status).toBe("skipped-main-wrote");
    expect(spy).not.toHaveBeenCalled();
  });

  it("delegates to runSubagent (forked mode) when main didn't write", async () => {
    const agent = makeAgent();
    const spy = vi
      .spyOn(subagentModule, "runSubagent")
      .mockResolvedValue({ mode: "forked", status: "completed", message: null });
    const out = await runExtractor({
      agent,
      sessionId: "s1",
      sessionMessages: [
        user("remember that I prefer pnpm"),
        asst([{ type: "text", text: "noted" }]),
      ],
      newMessageCount: 2,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0]![0] as Parameters<
      typeof subagentModule.runSubagent
    >[0] & { mode: "forked" };
    expect(args.mode).toBe("forked");
    expect(args.parent).toBe(agent);
    expect(args.parentSessionId).toBe("s1");
    expect(args.initialMessage).toContain("memory extraction subagent");
    expect(args.initialMessage).toContain("~2 messages");
    // Fork sees the parent's session as `contextMessages` so the
    // prompt's "messages above" actually points to a conversation,
    // not an empty history.
    expect(args.contextMessages).toBeDefined();
    expect(args.contextMessages!.length).toBe(2);
    expect(args.contextMessages![0]!.role).toBe("user");
    expect(args.contextMessages![1]!.role).toBe("assistant");
    // Fork is restricted to memory only — no shell/edit/web/etc on
    // unsupervised background work.
    expect(args.toolFilter).toBeInstanceOf(Set);
    expect(args.toolFilter!.has("memory")).toBe(true);
    expect(args.toolFilter!.size).toBe(1);
    // Telemetry tagged so dev Logfire dashboards split subagent vs main.
    expect(args.telemetryFunctionId).toBe(
      `${agent.config.id}:subagent.forked.extractor`
    );
    expect(out.status).toBe("completed");
  });

  it("propagates fork failures as failed status", async () => {
    const agent = makeAgent();
    vi.spyOn(subagentModule, "runSubagent").mockResolvedValue({
      mode: "forked",
      status: "failed",
      message: null,
      error: "model down",
    });
    const out = await runExtractor({
      agent,
      sessionId: "s1",
      sessionMessages: [user("x"), asst([{ type: "text", text: "y" }])],
      newMessageCount: 2,
    });
    expect(out.status).toBe("failed");
    expect(out.fork?.error).toBe("model down");
  });

  it("catches synchronous fork-launch exceptions and returns failed", async () => {
    const agent = makeAgent();
    vi.spyOn(subagentModule, "runSubagent").mockRejectedValue(
      new Error("launch boom")
    );
    const out = await runExtractor({
      agent,
      sessionId: "s1",
      sessionMessages: [user("x"), asst([{ type: "text", text: "y" }])],
      newMessageCount: 2,
    });
    expect(out.status).toBe("failed");
    expect(out.error).toContain("launch boom");
  });
});
