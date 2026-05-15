import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "@openacme/tasks";
import { registry } from "../src/registry.js";
import { bindTaskStore } from "../src/builtins/tasks.js";
import { toolCallContext } from "../src/session-context.js";

let dir: string;
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "openacme-tools-tasks-"));
  store = new TaskStore(dir);
  bindTaskStore({ store });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  name: string,
  args: Record<string, unknown>,
  ctx: { agentId?: string; sessionId?: string } = {}
): Promise<{ ok: boolean; [k: string]: unknown }> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`${name} not registered`);
  const exec = () => tool.handler(args);
  const out = ctx.agentId
    ? await toolCallContext.run(
        { agentId: ctx.agentId, sessionId: ctx.sessionId ?? "" },
        exec
      )
    : await exec();
  return JSON.parse(out);
}

describe("task_create", () => {
  it("creates a task and stamps created_by from context", async () => {
    const r = await call(
      "task_create",
      { title: "do the thing", assignee: "me" },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    const task = (r as { task: { created_by: string; assignee: string } })
      .task;
    expect(task.created_by).toBe("me");
    expect(task.assignee).toBe("me");
  });

  it("requires an agent context", async () => {
    const r = await call("task_create", {
      title: "x",
      assignee: "me",
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/agent context/);
  });

  it("honors sameSession only for self-assigned tasks", async () => {
    const r = await call(
      "task_create",
      { title: "x", assignee: "me", sameSession: true },
      { agentId: "me", sessionId: "s1" }
    );
    expect(r.ok).toBe(true);
    expect((r as { task: { session_id: string } }).task.session_id).toBe("s1");

    const cross = await call(
      "task_create",
      { title: "y", assignee: "you", sameSession: true },
      { agentId: "me", sessionId: "s1" }
    );
    expect(cross.ok).toBe(true);
    expect(
      (cross as { task: { session_id: string | null } }).task.session_id
    ).toBeNull();
    expect((cross as { warnings?: string[] }).warnings?.[0]).toMatch(
      /sameSession was ignored/
    );
  });

  it("rejects unknown depends_on", async () => {
    const r = await call(
      "task_create",
      { title: "x", assignee: "me", depends_on: ["missing"] },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/unknown_deps/);
  });
});

describe("task_list", () => {
  it("defaults to current agent and excludes done/canceled", async () => {
    const t = await store.create({
      title: "open",
      assignee: "me",
      created_by: "me",
    });
    const closed = await store.create({
      title: "done",
      assignee: "me",
      created_by: "me",
    });
    await store.update(closed.id, { status: "done" });
    await store.create({
      title: "other agent",
      assignee: "you",
      created_by: "me",
    });

    const r = await call("task_list", {}, { agentId: "me" });
    expect(r.ok).toBe(true);
    const ids = (r as { tasks: Array<{ id: string }> }).tasks.map((x) => x.id);
    expect(ids).toEqual([t.id]);
  });

  it("respects explicit assignee + status", async () => {
    await store.create({
      title: "x",
      assignee: "alice",
      created_by: "alice",
    });
    const blocked = await store.create({
      title: "y",
      assignee: "alice",
      created_by: "alice",
      depends_on: [],
    });
    await store.update(blocked.id, { status: "in_progress" });

    const r = await call(
      "task_list",
      { assignee: "alice", status: "in_progress" },
      { agentId: "bob" }
    );
    expect(r.ok).toBe(true);
    expect((r as { tasks: unknown[] }).tasks).toHaveLength(1);
  });
});

describe("task_view", () => {
  it("returns full body", async () => {
    const t = await store.create({
      title: "x",
      assignee: "me",
      created_by: "me",
      body: "Detailed description",
    });
    const r = await call("task_view", { id: t.id }, { agentId: "me" });
    expect(r.ok).toBe(true);
    expect((r as { task: { body: string } }).task.body.trim()).toBe(
      "Detailed description"
    );
  });

  it("returns ok:false when not found", async () => {
    const r = await call(
      "task_view",
      { id: "missing" },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
  });
});

describe("task_update", () => {
  it("marks done and clears in_progress slot", async () => {
    const t = await store.create({
      title: "x",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    await store.update(t.id, { status: "in_progress" });
    const r = await call(
      "task_update",
      { id: t.id, status: "done" },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    const reread = store.get(t.id)!;
    expect(reread.status).toBe("done");
    expect(reread.closed_at).toBeTruthy();
  });

  it("reassignment clears session_id automatically", async () => {
    const t = await store.create({
      title: "x",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    const r = await call(
      "task_update",
      { id: t.id, assignee: "other" },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    expect(
      (r as { task: { session_id: string | null } }).task.session_id
    ).toBeNull();
  });

  it("explicit null session_id detaches", async () => {
    const t = await store.create({
      title: "x",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    const r = await call(
      "task_update",
      { id: t.id, session_id: null },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    expect(
      (r as { task: { session_id: string | null } }).task.session_id
    ).toBeNull();
  });

  it("returns error code on session conflict", async () => {
    const a = await store.create({
      title: "a",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    const b = await store.create({
      title: "b",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    await store.update(a.id, { status: "in_progress" });

    const r = await call(
      "task_update",
      { id: b.id, status: "in_progress" },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/session_busy/);
  });
});

describe("recurrence via tools", () => {
  it("task_create accepts an interval recurrence and stamps runs/last_run_at defaults", async () => {
    const r = await call(
      "task_create",
      {
        title: "ping",
        assignee: "me",
        recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
      },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    const task = (r as { task: { recurrence: unknown; runs: number; last_run_at: string | null } }).task;
    expect(task.recurrence).toEqual({
      kind: "interval",
      every_ms: 60_000,
      session: "reuse",
    });
    expect(task.runs).toBe(0);
    expect(task.last_run_at).toBeNull();
  });

  it("task_update strips recurrence with null", async () => {
    const created = await call(
      "task_create",
      {
        title: "x",
        assignee: "me",
        recurrence: { kind: "interval", every_ms: 60_000, session: "fresh" },
      },
      { agentId: "me" }
    );
    const id = (created as { task: { id: string } }).task.id;
    const updated = await call(
      "task_update",
      { id, recurrence: null },
      { agentId: "me" }
    );
    expect(updated.ok).toBe(true);
    expect((updated as { task: { recurrence: unknown } }).task.recurrence).toBeNull();
  });

  it("task_update on a recurring task done returns status: open and bumps runs", async () => {
    const created = await call(
      "task_create",
      {
        title: "loop",
        assignee: "me",
        recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
      },
      { agentId: "me" }
    );
    const id = (created as { task: { id: string } }).task.id;
    const closed = await call(
      "task_update",
      { id, status: "done" },
      { agentId: "me" }
    );
    expect(closed.ok).toBe(true);
    const t = (closed as { task: { status: string; runs: number; last_run_at: string | null } }).task;
    expect(t.status).toBe("open");
    expect(t.runs).toBe(1);
    expect(t.last_run_at).toBeTruthy();
  });

  it("task_create rejects a malformed cron expression with a useful error", async () => {
    const r = await call(
      "task_create",
      {
        title: "x",
        assignee: "me",
        recurrence: { kind: "cron", expr: "not a cron", session: "fresh" },
      },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/invalid_input/);
  });
});
