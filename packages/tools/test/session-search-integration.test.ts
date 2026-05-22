import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  applySchema,
  createSessionStore,
  createMessageStore,
  type StoredUIMessage,
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

function userMsg(id: string, text: string): StoredUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
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
      search: (q, l, agentId) => messages.search(q, l, agentId),
      resolveRoot: (id) => sessions.getRoot(id),
    });
  });

  it("excludes the current conversation across a compression fork", async () => {
    sessions.create("a1", { id: "conv1-parent" });
    sessions.create("a1", {
      id: "conv1-child",
      parentSessionId: "conv1-parent",
    });
    messages.append(
      "conv1-parent",
      userMsg("m-c1p", "deploying to fly with docker")
    );
    messages.append(
      "conv1-child",
      userMsg("m-c1c", "still working on the docker fly setup")
    );

    sessions.create("a1", { id: "conv2" });
    messages.append(
      "conv2",
      userMsg("m-c2", "previously fixed a docker networking bug")
    );

    const res = await searchAs("docker", "conv1-child");
    expect(res.count).toBe(1);
    expect(res.results[0]!.sessionId).toBe("conv2");
  });

  it("collapses a 3-deep compression chain into one root hit", async () => {
    sessions.create("a1", { id: "chain-g" });
    sessions.create("a1", { id: "chain-p", parentSessionId: "chain-g" });
    sessions.create("a1", { id: "chain-c", parentSessionId: "chain-p" });
    messages.append("chain-g", userMsg("m-cg", "elevenlabs api token"));
    messages.append("chain-p", userMsg("m-cp", "elevenlabs voice clone"));
    messages.append("chain-c", userMsg("m-cc", "elevenlabs deploy"));

    sessions.create("a1", { id: "today" });
    const res = await searchAs("elevenlabs", "today");
    expect(res.count).toBe(1);
    expect(res.results[0]!.sessionId).toBe("chain-g");
  });

  it("surfaces multiple distinct conversations, ordered by best rank per root", async () => {
    sessions.create("a1", { id: "a" });
    sessions.create("a1", { id: "b" });
    sessions.create("a1", { id: "c" });
    messages.append(
      "a",
      userMsg("m-a", "the uniquetokenaaa appears once here")
    );
    messages.append(
      "b",
      userMsg(
        "m-b",
        "uniquetokenaaa uniquetokenaaa uniquetokenaaa repeated for relevance"
      )
    );
    messages.append("c", userMsg("m-c", "uniquetokenaaa here too"));
    sessions.create("a1", { id: "current" });

    const res = await searchAs("uniquetokenaaa", "current");
    expect(res.count).toBe(3);
    const ids = res.results.map((r) => r.sessionId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("b");
  });

  it("scopes results to the calling agent — coworker sessions excluded", async () => {
    // Agent A: two sessions with the keyword
    sessions.create("agent-a", { id: "a-sess-1" });
    messages.append(
      "a-sess-1",
      userMsg("m-a1", "uniquekw browser disconnect fixed")
    );
    sessions.create("agent-a", { id: "a-sess-2" });
    messages.append(
      "a-sess-2",
      userMsg("m-a2", "uniquekw timeout bumped to 60 minutes")
    );

    // Agent B: a session that also matches the keyword
    sessions.create("agent-b", { id: "b-sess-1" });
    messages.append(
      "b-sess-1",
      userMsg("m-b1", "uniquekw seen here in agent-b's session")
    );

    // Agent A's current session (will be excluded from its own results)
    sessions.create("agent-a", { id: "a-current" });

    const tools = registry.getVercelTools(new Set(["session_search"])) as {
      session_search: {
        execute: (args: Record<string, unknown>) => Promise<string>;
      };
    };

    // Agent A searching: should see a-sess-1 + a-sess-2, NOT b-sess-1.
    const aOut = await toolCallContext.run(
      { sessionId: "a-current", agentId: "agent-a" } as never,
      () => tools.session_search.execute({ query: "uniquekw", limit: 10 })
    );
    const aRes = JSON.parse(aOut) as SearchResult;
    const aIds = new Set(aRes.results.map((r) => r.sessionId));
    expect(aIds.has("a-sess-1")).toBe(true);
    expect(aIds.has("a-sess-2")).toBe(true);
    expect(aIds.has("b-sess-1")).toBe(false);

    // Agent B searching: should ONLY see b-sess-1, not agent-a's sessions.
    sessions.create("agent-b", { id: "b-current" });
    const bOut = await toolCallContext.run(
      { sessionId: "b-current", agentId: "agent-b" } as never,
      () => tools.session_search.execute({ query: "uniquekw", limit: 10 })
    );
    const bRes = JSON.parse(bOut) as SearchResult;
    expect(bRes.count).toBe(1);
    expect(bRes.results[0]!.sessionId).toBe("b-sess-1");
  });

  it("tool dispatched via Vercel-style tools registry sees ALS context", async () => {
    sessions.create("a1", { id: "other-conv" });
    messages.append("other-conv", userMsg("m-oc", "needle in haystack"));
    sessions.create("a1", { id: "active" });
    messages.append("active", userMsg("m-ac", "needle in active"));

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
