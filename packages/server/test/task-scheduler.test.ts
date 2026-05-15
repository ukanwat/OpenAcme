import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySchema,
  createSessionStore,
  createCommentStore,
  createEventStore,
  type SessionStore,
} from "@openacme/db";
import { TaskStore, type TaskEvent } from "@openacme/tasks";
import { AutonomousTurnTimeout } from "@openacme/agent-core";
import { TaskScheduler } from "../src/task-scheduler.js";

/**
 * Tests for TaskScheduler. Spins up a real DB + filesystem TaskStore
 * but mocks the AgentManager since the autonomous turn itself is
 * agent-core territory. The mock agent's `runAutonomous` is a spy that
 * returns whatever the test sets — success, throw, timeout — so the
 * scheduler's wake / park / pick paths are exercised in isolation.
 */

interface MockAgent {
  runAutonomous: ReturnType<typeof vi.fn>;
}

interface MockManager {
  getAgent: (id: string) => MockAgent;
  agents: Map<string, MockAgent>;
}

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

let dir: string;
let db: Database.Database;
let sessionStore: SessionStore;
let taskStore: TaskStore;
let manager: MockManager;
let scheduler: TaskScheduler;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "openacme-scheduler-"));
  db = freshDb();
  sessionStore = createSessionStore(db);
  const commentStore = createCommentStore(db);
  const eventStore = createEventStore(db);
  taskStore = new TaskStore(dir, { commentStore, eventStore });

  const agents = new Map<string, MockAgent>();
  manager = {
    agents,
    getAgent(id: string) {
      const a = agents.get(id);
      if (!a) throw new Error(`Agent not found: ${id}`);
      return a;
    },
  };

  scheduler = new TaskScheduler({
    taskStore,
    sessionStore,
    // Mock cast — we only ever call getAgent on this in scheduler code.
    agentManager: manager as unknown as Parameters<
      typeof TaskScheduler
    >[0]["agentManager"],
  });

  // Wire event-driven wake exactly like AgentManager does in production.
  eventStore.onEmit((event) => scheduler.onEvent(event));
});

afterEach(() => {
  scheduler.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeAgent(id: string, behavior?: () => Promise<void>): MockAgent {
  const a: MockAgent = {
    runAutonomous: vi.fn(async () => {
      if (behavior) await behavior();
    }),
  };
  manager.agents.set(id, a);
  return a;
}

async function flush(): Promise<void> {
  // Let microtasks settle so chains run.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setImmediate(r));
}

async function waitFor<T>(
  fn: () => T | undefined | null,
  timeoutMs = 1000
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("TaskScheduler — wake-only behavior", () => {
  it("does not pre-mark a task as in_progress before the agent runs", async () => {
    const agent = makeAgent("alice");
    // Block runAutonomous so we can observe the pre-call state.
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    agent.runAutonomous.mockImplementation(async () => {
      await blocked;
    });

    const t = await taskStore.create({
      title: "do thing",
      assignee: "alice",
      created_by: "alice",
    });
    await scheduler.start();

    // Wait for the scheduler to lazy-allocate a session and enqueue the
    // turn. Then check the task is still `open`, not `in_progress`.
    await waitFor(() => agent.runAutonomous.mock.calls.length > 0);
    const observed = taskStore.get(t.id);
    expect(observed?.status).toBe("open");
    expect(observed?.session_id).toBeTruthy();

    // The runAutonomous call carries only sessionId — no taskId.
    const arg = agent.runAutonomous.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.sessionId).toBe(observed?.session_id);
    expect(arg).not.toHaveProperty("taskId");

    release();
    await flush();
  });
});

describe("TaskScheduler — failure attribution", () => {
  it("on timeout, parks the in_progress task as blocked + system:scheduler comment", async () => {
    const agent = makeAgent("bob", async () => {
      throw new AutonomousTurnTimeout("synthetic timeout");
    });

    const t = await taskStore.create({
      title: "long work",
      assignee: "bob",
      created_by: "bob",
    });
    await scheduler.start();

    // Manually mark the task as in_progress AFTER the scheduler starts but
    // BEFORE we trigger its tick — this simulates the agent claiming the
    // task during the (synthetic) failed turn.
    await waitFor(() => agent.runAutonomous.mock.calls.length > 0);
    // The agent runs and throws — but in the test it never actually
    // claims the task. Simulate by setting it to in_progress directly,
    // then ticking again to retry. Easier: change the agent behavior to
    // claim before throwing.
    agent.runAutonomous.mockImplementation(async () => {
      await taskStore.update(t.id, { status: "in_progress" });
      throw new AutonomousTurnTimeout("synthetic timeout 2");
    });
    // Drop an external comment to re-fire a wake. (A no-op status patch
    // wouldn't emit an event.) comment_added → onEvent → 7s debounce →
    // wake → agent claims + throws → parkInProgress → blocked.
    await taskStore.addComment({
      taskId: t.id,
      author: "system:user",
      body: "retry please",
    });
    await waitFor(() => taskStore.get(t.id)?.status === "blocked", 12000);

    const final = taskStore.get(t.id);
    expect(final?.status).toBe("blocked");

    const sysComments = taskStore
      .listComments(t.id, { kinds: ["system"] })
      .filter((c) => c.author === "system:scheduler");
    expect(sysComments.length).toBeGreaterThan(0);
    expect(sysComments.some((c) => /timeout/i.test(c.body))).toBe(true);
  }, 15000);

  it("on generic error, parks the in_progress task with an [error] comment", async () => {
    const agent = makeAgent("carol");
    agent.runAutonomous.mockImplementation(async () => {
      const t = taskStore.list({ assignee: "carol" })[0];
      if (t) await taskStore.update(t.id, { status: "in_progress" });
      throw new Error("kaboom");
    });

    const t = await taskStore.create({
      title: "x",
      assignee: "carol",
      created_by: "carol",
    });
    await scheduler.start();
    await waitFor(() => taskStore.get(t.id)?.status === "blocked", 2000);

    const sysComments = taskStore
      .listComments(t.id, { kinds: ["system"] })
      .filter((c) => c.author === "system:scheduler");
    expect(sysComments.some((c) => /error/i.test(c.body))).toBe(true);
    expect(sysComments.some((c) => /kaboom/.test(c.body))).toBe(true);
  });

  it("on no in_progress task at failure time, no task gets parked (just logs)", async () => {
    const agent = makeAgent("dan");
    agent.runAutonomous.mockImplementation(async () => {
      // Never claim a task. Just throw.
      throw new Error("no claim");
    });

    const t = await taskStore.create({
      title: "x",
      assignee: "dan",
      created_by: "dan",
    });
    await scheduler.start();
    await waitFor(() => agent.runAutonomous.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 100));

    // Task should still be open (no claim, no park).
    expect(taskStore.get(t.id)?.status).toBe("open");
  });
});

describe("TaskScheduler — lazy session allocation", () => {
  it("creates a session for a ready unbound task on tick", async () => {
    makeAgent("eve", async () => {
      // No-op; we just want to observe the alloc.
    });

    const t = await taskStore.create({
      title: "x",
      assignee: "eve",
      created_by: "eve",
    });
    expect(t.session_id).toBeNull();

    await scheduler.start();
    await waitFor(() => taskStore.get(t.id)?.session_id !== null);

    const bound = taskStore.get(t.id);
    expect(bound?.session_id).toBeTruthy();
    expect(sessionStore.get(bound!.session_id!)).not.toBeNull();
  });

  it("does not allocate for a task whose deps aren't satisfied", async () => {
    makeAgent("frank", async () => {});
    const blocker = await taskStore.create({
      title: "blocker",
      assignee: "frank",
      created_by: "frank",
    });
    const dep = await taskStore.create({
      title: "depends",
      assignee: "frank",
      created_by: "frank",
      depends_on: [blocker.id],
    });
    expect(dep.status).toBe("blocked");

    await scheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(taskStore.get(dep.id)?.session_id).toBeNull();
  });
});

describe("TaskScheduler — wake policy", () => {
  it("event involving a session triggers a wake", async () => {
    const agent = makeAgent("greta", async () => {});
    const t = await taskStore.create({
      title: "x",
      assignee: "greta",
      created_by: "greta",
    });
    await scheduler.start();
    await waitFor(() => taskStore.get(t.id)?.session_id !== null);
    const callsAfterStart = agent.runAutonomous.mock.calls.length;

    // Add a fresh task — task_assigned event triggers immediate wake
    // (hard-eligibility kind, bypasses rate-limit; still goes through
    // the 7s debounce so we have to wait).
    await taskStore.create({
      title: "another",
      assignee: "greta",
      created_by: "outsider",
    });
    await waitFor(
      () => agent.runAutonomous.mock.calls.length > callsAfterStart,
      9000
    );
    expect(agent.runAutonomous.mock.calls.length).toBeGreaterThan(
      callsAfterStart
    );
  }, 12000);

  it("echo-suppresses events authored by the session's own agent", async () => {
    // The agent claims the task on first run so subsequent ticks find
    // no eligible work in the session — keeps the test from racing with
    // the basic tick path.
    const agent = makeAgent("hank");
    let claimed = false;
    agent.runAutonomous.mockImplementation(async () => {
      const mine = taskStore.list({ assignee: "hank" });
      if (!claimed && mine.length > 0 && mine[0]!.session_id) {
        await taskStore.update(mine[0]!.id, { status: "in_progress" });
        claimed = true;
      }
    });

    const t = await taskStore.create({
      title: "x",
      assignee: "hank",
      created_by: "hank",
    });
    await scheduler.start();
    await waitFor(() => claimed);
    await new Promise((r) => setTimeout(r, 100));
    const callsBeforeComment = agent.runAutonomous.mock.calls.length;
    expect(taskStore.get(t.id)?.status).toBe("in_progress");

    // Self-authored comment — should NOT trigger a wake (echo). Wait
    // past the 7s debounce window to confirm no scheduled wake fires.
    await taskStore.addComment({
      taskId: t.id,
      author: "hank",
      body: "I said something",
    });
    await new Promise((r) => setTimeout(r, 8000));
    expect(agent.runAutonomous.mock.calls.length).toBe(callsBeforeComment);
  }, 12000);
});

describe("TaskScheduler — recurring tasks", () => {
  it("recurring task self-resets to open with next start_at on done", async () => {
    let calls = 0;
    makeAgent("ivy", async () => {
      calls++;
    });

    const t = await taskStore.create({
      title: "daily",
      assignee: "ivy",
      created_by: "ivy",
      recurrence: { kind: "interval", every_ms: 60_000, session: "fresh" },
    });
    await scheduler.start();
    await waitFor(() => calls > 0);

    // Mark done — recurring self-reset returns status "open" with a
    // future start_at.
    const closed = await taskStore.update(t.id, { status: "done" });
    expect(closed.status).toBe("open");
    expect(closed.runs).toBe(1);
    expect(closed.start_at).toBeTruthy();
    // The new start_at is in the future (we just fired ms ago).
    const start = Date.parse(closed.start_at!);
    expect(start).toBeGreaterThan(Date.now());
  });
});

describe("TaskScheduler — agent-missing handling", () => {
  it("logs and bails without parking when agent is unavailable", async () => {
    const t = await taskStore.create({
      title: "x",
      assignee: "ghost",
      created_by: "ghost",
    });
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    // Task should still be open — scheduler doesn't park anything when
    // it can't reach the agent. The next tick will retry; humans escalate
    // if the agent stays missing.
    expect(taskStore.get(t.id)?.status).toBe("open");
  });
});
