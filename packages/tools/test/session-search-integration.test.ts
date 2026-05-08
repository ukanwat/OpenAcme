import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  applySchema,
  createSessionStore,
  createMessageStore,
} from "@openacme/db";
import { registry } from "../src/registry.js";
import { bindSessionSearch } from "../src/builtins/session-search.js";
import { toolCallContext } from "../src/session-context.js";

interface SearchResult {
  success: boolean;
  query: string;
  count: number;
  results: Array<{
    sessionId: string;
    role: string;
    rank: number;
    content: string;
  }>;
}

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

async function searchAs(
  query: string,
  currentSessionId: string,
  limit = 10
): Promise<SearchResult> {
  const tool = registry.get("session_search");
  if (!tool) throw new Error("session_search not registered");
  const out = await toolCallContext.run({ sessionId: currentSessionId }, () =>
    tool.handler({ query, limit })
  );
  return JSON.parse(out) as SearchResult;
}

/**
 * End-to-end wiring test: real SQLite + FTS5 + real SessionStore.getRoot +
 * real session-search handler + AsyncLocalStorage. Exercises the path that
 * AgentManager wires up at runtime.
 *
 * Catches regressions where the ALS instance the agent enters into doesn't
 * match the one the tool reads from — a real risk if module resolution ever
 * splits across `dist/` and `src/` copies.
 */
describe("session_search — full DB integration", () => {
  let db: Database.Database;
  let sessions: ReturnType<typeof createSessionStore>;
  let messages: ReturnType<typeof createMessageStore>;

  beforeEach(() => {
    db = freshDb();
    sessions = createSessionStore(db);
    messages = createMessageStore(db);
    bindSessionSearch({
      search: (q, l) => messages.search(q, l),
      resolveRoot: (id) => sessions.getRoot(id),
    });
  });

  it("excludes the current conversation across a compression fork", async () => {
    // Conversation 1: parent → child (compressed). Both have matching content.
    sessions.create("a1", { id: "conv1-parent" });
    sessions.create("a1", {
      id: "conv1-child",
      parentSessionId: "conv1-parent",
    });
    messages.append("conv1-parent", {
      sessionId: "conv1-parent",
      role: "user",
      content: "deploying to fly with docker",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });
    messages.append("conv1-child", {
      sessionId: "conv1-child",
      role: "user",
      content: "still working on the docker fly setup",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });

    // Conversation 2: a totally separate past session with the same topic.
    sessions.create("a1", { id: "conv2" });
    messages.append("conv2", {
      sessionId: "conv2",
      role: "user",
      content: "previously fixed a docker networking bug",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });

    // Search from inside conv1's child — only conv2 should surface.
    const res = await searchAs("docker", "conv1-child");
    expect(res.count).toBe(1);
    expect(res.results[0]!.sessionId).toBe("conv2");
  });

  it("collapses a 3-deep compression chain into one root hit", async () => {
    sessions.create("a1", { id: "chain-g" });
    sessions.create("a1", { id: "chain-p", parentSessionId: "chain-g" });
    sessions.create("a1", { id: "chain-c", parentSessionId: "chain-p" });
    messages.append("chain-g", {
      sessionId: "chain-g",
      role: "user",
      content: "elevenlabs api token",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });
    messages.append("chain-p", {
      sessionId: "chain-p",
      role: "user",
      content: "elevenlabs voice clone",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });
    messages.append("chain-c", {
      sessionId: "chain-c",
      role: "user",
      content: "elevenlabs deploy",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });

    // Brand-new unrelated session is "current".
    sessions.create("a1", { id: "today" });
    const res = await searchAs("elevenlabs", "today");
    expect(res.count).toBe(1);
    expect(res.results[0]!.sessionId).toBe("chain-g"); // root, not p or c
  });

  it("surfaces multiple distinct conversations, ordered by best rank per root", async () => {
    sessions.create("a1", { id: "a" });
    sessions.create("a1", { id: "b" });
    sessions.create("a1", { id: "c" });
    messages.append("a", {
      sessionId: "a",
      role: "user",
      content: "the uniquetokenaaa appears once here",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });
    messages.append("b", {
      sessionId: "b",
      role: "user",
      content:
        "uniquetokenaaa uniquetokenaaa uniquetokenaaa repeated for relevance",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });
    messages.append("c", {
      sessionId: "c",
      role: "user",
      content: "uniquetokenaaa here too",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });
    sessions.create("a1", { id: "current" });

    const res = await searchAs("uniquetokenaaa", "current");
    // BM25 should rank b first (most repetitions). Just verify it appears
    // and that all three roots are present, distinct.
    expect(res.count).toBe(3);
    const ids = res.results.map((r) => r.sessionId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("b");
  });

  it("tool dispatched via Vercel-style tools registry sees ALS context", async () => {
    // The agent path uses getVercelTools().execute, not the raw handler.
    // Verify ALS still propagates through that wrapper.
    sessions.create("a1", { id: "other-conv" });
    messages.append("other-conv", {
      sessionId: "other-conv",
      role: "user",
      content: "needle in haystack",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });
    sessions.create("a1", { id: "active" });
    messages.append("active", {
      sessionId: "active",
      role: "user",
      content: "needle in active",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
    });

    const tools = registry.getVercelTools(new Set(["session_search"])) as {
      session_search: {
        execute: (args: Record<string, unknown>) => Promise<string>;
      };
    };
    const out = await toolCallContext.run({ sessionId: "active" }, () =>
      tools.session_search.execute({ query: "needle", limit: 5 })
    );
    const res = JSON.parse(out) as SearchResult;
    expect(res.count).toBe(1);
    expect(res.results[0]!.sessionId).toBe("other-conv");
  });
});
