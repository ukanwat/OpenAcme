import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../src/connection.js";
import { createSessionStore } from "../src/stores/session-store.js";
import { createMessageStore } from "../src/stores/message-store.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  // sessions.agent_id is now a plain text label (agents live as YAML files,
  // not in this DB) — no seed row needed.
  return db;
}

describe("SessionStore — fork chain", () => {
  let db: Database.Database;
  let sessions: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    db = freshDb();
    sessions = createSessionStore(db);
  });

  it("create roundtrips parent_session_id", () => {
    const parent = sessions.create("a1", { id: "s-parent" });
    expect(parent.parentSessionId).toBeNull();

    const child = sessions.create("a1", {
      id: "s-child",
      parentSessionId: parent.id,
    });
    expect(child.parentSessionId).toBe(parent.id);

    const refetched = sessions.get(child.id);
    expect(refetched?.parentSessionId).toBe(parent.id);
  });

  it("findChildOf returns null with no child, then the child once created", () => {
    const parent = sessions.create("a1", { id: "p1" });
    expect(sessions.findChildOf(parent.id)).toBeNull();
    const child = sessions.createChildIfNoSibling("a1", parent.id, {
      title: "x",
    });
    expect(child).not.toBeNull();
    const found = sessions.findChildOf(parent.id);
    expect(found?.id).toBe(child!.id);
    expect(found?.parentSessionId).toBe(parent.id);
  });

  it("createChildIfNoSibling refuses a second child of the same parent", () => {
    const parent = sessions.create("a1", { id: "p2" });
    const c1 = sessions.createChildIfNoSibling("a1", parent.id);
    const c2 = sessions.createChildIfNoSibling("a1", parent.id);
    expect(c1).not.toBeNull();
    expect(c2).toBeNull(); // race-loser
    // findChildOf still returns the original winner.
    expect(sessions.findChildOf(parent.id)?.id).toBe(c1!.id);
  });

  it("listActive hides compressed-away parents but keeps the active child visible", () => {
    const standalone = sessions.create("a1", { id: "standalone" });
    const parent = sessions.create("a1", { id: "parent" });
    const child = sessions.createChildIfNoSibling("a1", parent.id);

    const active = sessions.listActive("a1").map((s) => s.id);
    expect(active).toContain(standalone.id);
    expect(active).not.toContain(parent.id);
    // The child is the live conversation post-fork — it must stay visible
    // in the sidebar, otherwise the user loses access to their chat after
    // compression triggers.
    expect(active).toContain(child!.id);
  });

  it("inherits title via opts when forking from a titled parent", () => {
    sessions.create("a1", { id: "p3", title: "Parent title" });
    sessions.updateTitle("p3", "Parent title");
    const child = sessions.createChildIfNoSibling("a1", "p3", {
      title: "Parent title",
    });
    expect(child?.title).toBe("Parent title");
  });
});

describe("MessageStore — appendMany and ordering", () => {
  let db: Database.Database;
  let sessions: ReturnType<typeof createSessionStore>;
  let messages: ReturnType<typeof createMessageStore>;

  beforeEach(() => {
    db = freshDb();
    sessions = createSessionStore(db);
    messages = createMessageStore(db);
    sessions.create("a1", { id: "s1" });
  });

  it("appendMany inserts all messages and returns them in order", () => {
    const out = messages.appendMany("s1", [
      { sessionId: "s1", role: "user", content: "a", toolCalls: null, toolCallId: null, toolName: null },
      { sessionId: "s1", role: "assistant", content: "b", toolCalls: null, toolCallId: null, toolName: null },
      { sessionId: "s1", role: "user", content: "c", toolCalls: null, toolCallId: null, toolName: null },
    ]);
    expect(out.length).toBe(3);
    expect(out.map((m) => m.content)).toEqual(["a", "b", "c"]);
  });

  it("getHistory returns messages in insertion order even when created_at ties", () => {
    // unixepoch() is second-resolution; a tight bulk insert lands inside
    // a single second. The ORDER BY rowid tie-break must keep insertion
    // order; otherwise the agent's tool-call/tool-result pairing breaks.
    const inputs: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < 50; i++) {
      inputs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` });
    }
    messages.appendMany(
      "s1",
      inputs.map((m) => ({
        sessionId: "s1",
        role: m.role,
        content: m.content,
        toolCalls: null,
        toolCallId: null,
        toolName: null,
      }))
    );

    const loaded = messages.getHistory("s1");
    expect(loaded.length).toBe(50);
    expect(loaded.map((m) => m.content)).toEqual(inputs.map((i) => i.content));
  });

  it("appendMany is atomic — partial failure rolls back", () => {
    // Force a NOT NULL violation on the second row to trigger rollback.
    expect(() =>
      messages.appendMany("s1", [
        { sessionId: "s1", role: "user", content: "ok", toolCalls: null, toolCallId: null, toolName: null },
        // Invalid: role is NOT NULL — passing null reaches the bind layer
        // and SQLite rejects the row.
        { sessionId: "s1", role: null as unknown as "user", content: "bad", toolCalls: null, toolCallId: null, toolName: null },
      ])
    ).toThrow();

    // Neither row should have been persisted.
    const history = messages.getHistory("s1");
    expect(history.length).toBe(0);
  });

  it("FTS5 search still finds rows inserted via appendMany", () => {
    messages.appendMany("s1", [
      { sessionId: "s1", role: "user", content: "the quick brown fox", toolCalls: null, toolCallId: null, toolName: null },
      { sessionId: "s1", role: "assistant", content: "lazy dog", toolCalls: null, toolCallId: null, toolName: null },
    ]);
    const hits = messages.search("brown");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain("brown");
  });
});
