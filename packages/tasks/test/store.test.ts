import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore, TaskStoreError } from "../src/store.js";

let dir: string;
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "openacme-tasks-"));
  store = new TaskStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskStore CRUD", () => {
  it("creates a task and reads it back", async () => {
    const t = await store.create({
      title: "Ship the auth flow",
      assignee: "backend",
      created_by: "founder-agent",
      body: "Body content here.",
    });

    expect(t.id).toBeTruthy();
    expect(t.status).toBe("open");
    expect(t.created_at).toBe(t.updated_at);
    expect(existsSync(path.join(dir, `${t.id}.md`))).toBe(true);

    const read = store.get(t.id);
    expect(read).not.toBeNull();
    expect(read!.title).toBe("Ship the auth flow");
    expect(read!.body.trim()).toBe("Body content here.");
  });

  it("updates fields and bumps updated_at", async () => {
    const t = await store.create({
      title: "Original",
      assignee: "a",
      created_by: "a",
    });
    await new Promise((r) => setTimeout(r, 10));
    const updated = await store.update(t.id, {
      title: "Renamed",
      body: "New body",
    });
    expect(updated.title).toBe("Renamed");
    expect(updated.body).toBe("New body");
    expect(updated.updated_at > t.updated_at).toBe(true);
  });

  it("rejects update on missing id", async () => {
    await expect(
      store.update("does-not-exist", { title: "x" })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("delete removes the file", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
    });
    await store.delete(t.id);
    expect(store.get(t.id)).toBeNull();
  });

  it("delete refuses to remove tasks with dependents unless forced", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      depends_on: [a.id],
    });
    await expect(store.delete(a.id)).rejects.toMatchObject({
      code: "has_dependents",
    });
    await store.delete(a.id, { force: true });
    expect(store.get(a.id)).toBeNull();
    expect(store.get(b.id)).toBeNull();
  });

  it("list skips dotfiles and malformed", async () => {
    const t = await store.create({
      title: "ok",
      assignee: "a",
      created_by: "a",
    });
    // Drop a malformed file alongside.
    const fs = await import("node:fs");
    fs.writeFileSync(path.join(dir, "garbage.md"), "not yaml");
    fs.writeFileSync(path.join(dir, ".hidden.md"), "---\n---\nbody");
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(t.id);
  });
});

describe("TaskStore dependencies", () => {
  it("auto-blocks when deps unmet, auto-opens when satisfied", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      depends_on: [a.id],
    });
    expect(b.status).toBe("blocked");

    await store.update(a.id, { status: "done" });
    const refreshed = store.get(b.id)!;
    expect(refreshed.status).toBe("open");
  });

  it("rejects unknown dep ids", async () => {
    await expect(
      store.create({
        title: "x",
        assignee: "a",
        created_by: "a",
        depends_on: ["missing-id"],
      })
    ).rejects.toMatchObject({ code: "unknown_deps" });
  });

  it("rejects cycles", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      depends_on: [a.id],
    });
    // Now make a depend on b → cycle.
    await expect(
      store.update(a.id, { depends_on: [b.id] })
    ).rejects.toMatchObject({ code: "cycle" });
  });

  it("canceled deps do not satisfy", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      depends_on: [a.id],
    });
    await store.update(a.id, { status: "canceled" });
    const refreshed = store.get(b.id)!;
    expect(refreshed.status).toBe("blocked");
  });
});

describe("TaskStore session queue", () => {
  it("enforces at most one in_progress per session", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
    });

    await store.update(a.id, { status: "in_progress" });
    await expect(
      store.update(b.id, { status: "in_progress" })
    ).rejects.toMatchObject({ code: "session_busy" });
  });

  it("queueFor orders by created_at and skips ineligible", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
    });
    await new Promise((r) => setTimeout(r, 10));
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
    });
    await new Promise((r) => setTimeout(r, 10));
    // future-dated task → not eligible.
    const future = new Date(Date.now() + 60_000).toISOString();
    await store.create({
      title: "future",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
      start_at: future,
    });

    const q = store.queueFor("s1");
    expect(q.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("nextEligibleFor returns the head", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
    });
    expect(store.nextEligibleFor("s1")?.id).toBe(a.id);
    await store.update(a.id, { status: "in_progress" });
    expect(store.nextEligibleFor("s1")?.id).toBeUndefined();
  });

  it("reassignment clears session_id automatically", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      session_id: "s1",
    });
    const updated = await store.update(t.id, { assignee: "b" });
    expect(updated.session_id).toBeNull();
  });

  it("explicit session_id in same call as reassignment wins", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      session_id: "s1",
    });
    const updated = await store.update(t.id, {
      assignee: "b",
      session_id: "s2",
    });
    expect(updated.session_id).toBe("s2");
  });
});

describe("TaskStore restart sweep", () => {
  it("resets in_progress tasks older than threshold to open", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      session_id: "s1",
    });
    await store.update(t.id, { status: "in_progress" });

    // simulate stale: write the file with an old updated_at.
    const fs = await import("node:fs");
    const file = path.join(dir, `${t.id}.md`);
    let content = fs.readFileSync(file, "utf-8");
    const oldIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    content = content.replace(
      /updated_at:.*\n/,
      `updated_at: '${oldIso}'\n`
    );
    fs.writeFileSync(file, content);

    const reset = await store.sweepStale();
    expect(reset).toContain(t.id);
    expect(store.get(t.id)!.status).toBe("open");
  });
});

describe("TaskStore renderForPrompt", () => {
  it("groups by status and includes due/start info", async () => {
    const a = await store.create({
      title: "Active task",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    await store.update(a.id, { status: "in_progress" });

    await store.create({
      title: "Queued task",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });

    await store.create({
      title: "Future task",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
      start_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await store.create({
      title: "Other session",
      assignee: "me",
      created_by: "me",
      session_id: "s2",
    });

    await store.create({
      title: "Delegated",
      assignee: "you",
      created_by: "me",
    });

    const out = store.renderForPrompt("me", "s1", () => true);
    expect(out).toContain("Active in this session");
    expect(out).toContain("Queued in this session");
    expect(out).toContain("Scheduled later");
    expect(out).toContain("In another session");
    expect(out).toContain("Created by me, assigned to others");
    expect(out).toContain("Active task");
    expect(out).toContain("Delegated");
  });

  it("returns empty string when no tasks for agent", () => {
    expect(store.renderForPrompt("nobody", "s1", () => true)).toBe("");
  });

  it("filters out tasks bound to deleted sessions", async () => {
    await store.create({
      title: "ghost",
      assignee: "me",
      created_by: "me",
      session_id: "deleted-session",
    });
    const out = store.renderForPrompt("me", "s1", () => false);
    expect(out).not.toContain("ghost");
  });
});

describe("TaskStore onChange", () => {
  it("fires onChange after mutating calls", async () => {
    let count = 0;
    store.setOnChange(() => {
      count++;
    });
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
    });
    expect(count).toBe(1);
    await store.update(t.id, { title: "y" });
    expect(count).toBe(2);
    await store.delete(t.id);
    expect(count).toBe(3);
  });
});

describe("TaskStore atomic write", () => {
  it("does not leave .tmp files on success", async () => {
    await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
    });
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith(".task_"))).toBe(false);
  });
});

describe("TaskStore malformed-file handling", () => {
  it("warns once per malformed file across many list() calls", async () => {
    const fs = await import("node:fs");
    fs.writeFileSync(path.join(dir, "broken.md"), "not yaml");
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      store.list();
      store.list();
      store.list();
      const calls = warn.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("Skipping malformed task file")
      );
      expect(calls.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("TaskStore input validation", () => {
  it("rejects invalid start_at on create", async () => {
    await expect(
      store.create({
        title: "x",
        assignee: "a",
        created_by: "a",
        start_at: "not-an-iso",
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects invalid due_at on update", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
    });
    await expect(
      store.update(t.id, { due_at: "garbage" })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects empty title on create", async () => {
    await expect(
      store.create({ title: "", assignee: "a", created_by: "a" })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("accepts valid ISO with offset", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      start_at: "2030-01-01T00:00:00.000Z",
    });
    expect(t.start_at).toBe("2030-01-01T00:00:00.000Z");
  });
});

describe("TaskStore recurrence", () => {
  it("interval recurrence: done self-resets to open with advanced start_at, runs+1, last_run_at set", async () => {
    const t = await store.create({
      title: "ping",
      assignee: "a",
      created_by: "a",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    expect(t.recurrence).toEqual({
      kind: "interval",
      every_ms: 60_000,
      session: "reuse",
    });
    expect(t.runs).toBe(0);
    expect(t.last_run_at).toBeNull();
    expect(t.start_at).toBeTruthy();

    const before = Date.parse(t.start_at!);
    const result = await store.update(t.id, { status: "done" });

    expect(result.status).toBe("open");
    expect(result.runs).toBe(1);
    expect(result.last_run_at).toBeTruthy();
    expect(result.closed_at).toBeNull();
    expect(Date.parse(result.start_at!)).toBeGreaterThan(before);
  });

  it("cron recurrence: first start_at honors expression; reset advances to nextRun", async () => {
    const t = await store.create({
      title: "daily",
      assignee: "a",
      created_by: "a",
      recurrence: { kind: "cron", expr: "0 0 * * *", session: "fresh" },
    });
    const firstStart = Date.parse(t.start_at!);
    expect(firstStart).toBeGreaterThan(Date.now());

    const after = await store.update(t.id, { status: "done" });
    expect(after.status).toBe("open");
    expect(Date.parse(after.start_at!)).toBeGreaterThan(firstStart);
  });

  it("count cap stops self-reset once reached", async () => {
    const t = await store.create({
      title: "twice",
      assignee: "a",
      created_by: "a",
      recurrence: {
        kind: "interval",
        every_ms: 60_000,
        count: 2,
        session: "reuse",
      },
    });
    const r1 = await store.update(t.id, { status: "done" });
    expect(r1.status).toBe("open");
    expect(r1.runs).toBe(1);

    const r2 = await store.update(t.id, { status: "done" });
    expect(r2.status).toBe("done");
    expect(r2.runs).toBe(2);
    expect(r2.closed_at).toBeTruthy();
  });

  it("until cap: nextFire past until → stays done", async () => {
    const soon = new Date(Date.now() + 200).toISOString();
    const t = await store.create({
      title: "fleeting",
      assignee: "a",
      created_by: "a",
      recurrence: {
        kind: "interval",
        every_ms: 60_000,
        until: soon,
        session: "reuse",
      },
    });
    await new Promise((r) => setTimeout(r, 250));
    const r = await store.update(t.id, { status: "done" });
    expect(r.status).toBe("done");
    expect(r.closed_at).toBeTruthy();
  });

  it("session: fresh clears session_id on reset; reuse keeps it", async () => {
    const tFresh = await store.create({
      title: "fresh",
      assignee: "a",
      created_by: "a",
      session_id: "s1",
      recurrence: { kind: "interval", every_ms: 60_000, session: "fresh" },
    });
    const rFresh = await store.update(tFresh.id, { status: "done" });
    expect(rFresh.session_id).toBeNull();

    const tReuse = await store.create({
      title: "reuse",
      assignee: "a",
      created_by: "a",
      session_id: "s2",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    const rReuse = await store.update(tReuse.id, { status: "done" });
    expect(rReuse.session_id).toBe("s2");
  });

  it("canceled never self-resets even with active recurrence", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    const r = await store.update(t.id, { status: "canceled" });
    expect(r.status).toBe("canceled");
    expect(r.runs).toBe(0);
    expect(r.closed_at).toBeTruthy();
  });

  it("explicit blocked never self-resets (errored turn shouldn't loop)", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    const r = await store.update(t.id, { status: "blocked" });
    expect(r.status).toBe("blocked");
    expect(r.runs).toBe(0);
  });

  it("recurrence: null on update strips recurrence; subsequent done sticks", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    const stripped = await store.update(t.id, { recurrence: null });
    expect(stripped.recurrence).toBeNull();
    const closed = await store.update(t.id, { status: "done" });
    expect(closed.status).toBe("done");
    expect(closed.runs).toBe(0);
    expect(closed.closed_at).toBeTruthy();
  });

  it("recurring task done: dependents do NOT unblock on transient close", async () => {
    const a = await store.create({
      title: "recurring-a",
      assignee: "x",
      created_by: "x",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      depends_on: [a.id],
    });
    expect(b.status).toBe("blocked");
    await store.update(a.id, { status: "done" });
    const refreshedB = store.get(b.id)!;
    expect(refreshedB.status).toBe("blocked");
  });

  it("rejects invalid cron expr at the write boundary", async () => {
    await expect(
      store.create({
        title: "x",
        assignee: "a",
        created_by: "a",
        recurrence: { kind: "cron", expr: "not a cron", session: "fresh" },
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects recurrence.until in the past", async () => {
    await expect(
      store.create({
        title: "x",
        assignee: "a",
        created_by: "a",
        recurrence: {
          kind: "interval",
          every_ms: 60_000,
          until: "2000-01-01T00:00:00.000Z",
          session: "fresh",
        },
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects every_ms < MIN_INTERVAL_MS", async () => {
    await expect(
      store.create({
        title: "x",
        assignee: "a",
        created_by: "a",
        recurrence: {
          kind: "interval",
          every_ms: 1000,
          session: "fresh",
        },
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("renderForPrompt annotates recurring tasks with cadence + run count", async () => {
    const t = await store.create({
      title: "daily check",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
      recurrence: { kind: "cron", expr: "0 9 * * *", session: "reuse" },
    });
    await store.update(t.id, { status: "in_progress" });
    const out = store.renderForPrompt("me", "s1", () => true);
    expect(out).toContain("daily check");
    expect(out).toContain("cron 0 9 * * *");
    expect(out).toContain("ran 0×");
  });
});

// ── Comments + events wiring ────────────────────────────────────────

import type {
  Comment,
  CommentInput,
  CommentListOptions,
  CommentStorePort,
  EventInput,
  EventStorePort,
} from "../src/ports.js";
import { randomUUID } from "node:crypto";

function makeStores() {
  const comments: Comment[] = [];
  const commentStore: CommentStorePort = {
    add(input: CommentInput): Comment {
      const c: Comment = {
        id: randomUUID(),
        taskId: input.taskId,
        author: input.author,
        kind: input.kind ?? null,
        body: input.body,
        createdAt: Math.floor(Date.now() / 1000),
      };
      comments.push(c);
      return c;
    },
    list(taskId: string, opts: CommentListOptions = {}): Comment[] {
      let out = comments
        .filter((c) => c.taskId === taskId)
        .sort((a, b) => a.createdAt - b.createdAt);
      if (opts.sinceTs !== undefined) {
        out = out.filter((c) => c.createdAt > opts.sinceTs!);
      }
      if (opts.kinds && opts.kinds.length > 0) {
        out = out.filter((c) => c.kind && opts.kinds!.includes(c.kind));
      }
      if (opts.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    },
    latestResult(taskId: string): Comment | null {
      const results = comments
        .filter((c) => c.taskId === taskId && c.kind === "result")
        .sort((a, b) => b.createdAt - a.createdAt);
      return results[0] ?? null;
    },
    countByTask(taskIds: string[]): Map<string, number> {
      const m = new Map<string, number>();
      for (const c of comments) {
        if (taskIds.includes(c.taskId)) {
          m.set(c.taskId, (m.get(c.taskId) ?? 0) + 1);
        }
      }
      return m;
    },
    deleteByTask(taskId: string): void {
      for (let i = comments.length - 1; i >= 0; i--) {
        if (comments[i]!.taskId === taskId) comments.splice(i, 1);
      }
    },
  };

  const events: (EventInput & { ts: number })[] = [];
  const eventStore: EventStorePort = {
    append(input: EventInput) {
      const row = { ...input, ts: Date.now() };
      events.push(row);
      return row;
    },
  };

  return { commentStore, eventStore, comments, events };
}

describe("TaskStore comments", () => {
  it("adds and lists comments via store delegation", async () => {
    const { commentStore, eventStore, comments } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({
      title: "review pr",
      assignee: "reviewer",
      created_by: "author",
    });

    const c = await s.addComment({
      taskId: t.id,
      author: "author",
      body: "any blockers?",
    });
    expect(c).not.toBeNull();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toBe("any blockers?");

    const list = s.listComments(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.author).toBe("author");
  });

  it("marks the assignee's result comment as the canonical result", async () => {
    const { commentStore, eventStore } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({
      title: "compute",
      assignee: "data",
      created_by: "pm",
    });
    await s.addComment({
      taskId: t.id,
      author: "data",
      body: "first attempt",
    });
    await s.addComment({
      taskId: t.id,
      author: "data",
      body: "answer is 42",
      kind: "result",
    });
    const r = s.latestResult(t.id);
    expect(r).not.toBeNull();
    expect(r!.body).toBe("answer is 42");
  });

  it("returns counts grouped by task", async () => {
    const { commentStore, eventStore } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t1 = await s.create({ title: "a", assignee: "x", created_by: "x" });
    const t2 = await s.create({ title: "b", assignee: "x", created_by: "x" });
    await s.addComment({ taskId: t1.id, author: "x", body: "1" });
    await s.addComment({ taskId: t1.id, author: "x", body: "2" });
    await s.addComment({ taskId: t2.id, author: "x", body: "3" });
    const counts = s.commentCounts([t1.id, t2.id]);
    expect(counts.get(t1.id)).toBe(2);
    expect(counts.get(t2.id)).toBe(1);
  });

  it("rejects comment on missing task", async () => {
    const { commentStore, eventStore } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    await expect(
      s.addComment({ taskId: "ghost", author: "x", body: "?" })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("clears comments on task delete", async () => {
    const { commentStore, eventStore, comments } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    await s.addComment({ taskId: t.id, author: "a", body: "note" });
    expect(comments).toHaveLength(1);
    await s.delete(t.id);
    expect(comments).toHaveLength(0);
  });

  it("no-ops when no commentStore is wired", async () => {
    const s = new TaskStore(dir);
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    const c = await s.addComment({
      taskId: t.id,
      author: "a",
      body: "ignored",
    });
    expect(c).toBeNull();
    expect(s.listComments(t.id)).toEqual([]);
    expect(s.latestResult(t.id)).toBeNull();
    expect(s.commentCounts([t.id]).size).toBe(0);
  });
});

describe("TaskStore event emission", () => {
  it("emits task_assigned on create", async () => {
    const { commentStore, eventStore, events } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    await s.create({ title: "x", assignee: "doer", created_by: "boss" });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("task_assigned");
    // `agent_id` is the assignee (who the event concerns); `actor` is
    // null so echo suppression never blocks a fresh task from waking
    // its assignee.
    expect(events[0]!.agentId).toBe("doer");
    expect(events[0]!.actor).toBeNull();
    expect(events[0]!.payload).toMatchObject({
      assignee: "doer",
      created_by: "boss",
    });
  });

  it("emits status_changed only when status actually changes", async () => {
    const { commentStore, eventStore, events } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    events.length = 0;
    await s.update(t.id, { title: "renamed" }); // not a status change
    expect(events.filter((e) => e.kind === "status_changed")).toHaveLength(0);
    await s.update(t.id, { status: "in_progress" });
    const change = events.find((e) => e.kind === "status_changed");
    expect(change).toBeDefined();
    expect(change!.payload).toMatchObject({ from: "open", to: "in_progress" });
  });

  it("emits comment_added on addComment", async () => {
    const { commentStore, eventStore, events } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    events.length = 0;
    await s.addComment({
      taskId: t.id,
      author: "b",
      body: "hi",
      kind: "result",
    });
    const e = events.find((e) => e.kind === "comment_added");
    expect(e).toBeDefined();
    expect(e!.agentId).toBe("b");
    expect(e!.payload).toMatchObject({ kind: "result" });
  });

  it("emits dep_unblocked when dependents auto-unblock", async () => {
    const { commentStore, eventStore, events } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const blocker = await s.create({
      title: "blocker",
      assignee: "x",
      created_by: "x",
    });
    const dep = await s.create({
      title: "dependent",
      assignee: "y",
      created_by: "x",
      depends_on: [blocker.id],
    });
    expect(dep.status).toBe("blocked");
    events.length = 0;

    await s.update(blocker.id, { status: "done" });
    const unblock = events.find((e) => e.kind === "dep_unblocked");
    expect(unblock).toBeDefined();
    expect(unblock!.taskId).toBe(dep.id);
    expect(unblock!.agentId).toBe("y");
    expect(unblock!.payload).toMatchObject({ blocked_by_task_id: blocker.id });
  });

  it("does not emit when no eventStore is wired", async () => {
    const s = new TaskStore(dir);
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    await s.update(t.id, { status: "in_progress" });
    // Just confirm nothing throws and store works without the dep.
    expect(s.get(t.id)?.status).toBe("in_progress");
  });
});
