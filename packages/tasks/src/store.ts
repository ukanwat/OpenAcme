/**
 * File-backed task store. One markdown file per task at
 * `<tasksDir>/<id>.md` — YAML frontmatter for structured fields, body
 * for the agent-readable description and accumulated notes.
 *
 * Concurrency: per-task in-process async mutex serializes
 * read-modify-write of a single id. Each operation only acquires one
 * mutex at a time — fan-out paths (`unblockDependents`, `delete --force`)
 * iterate sequentially without holding multiple locks, so there's no
 * deadlock surface.
 *
 * The store enforces:
 *   - cycle-free `depends_on` graph (DFS on write).
 *   - status auto-transition between `open` and `blocked` based on deps.
 *   - at most one `in_progress` per `session_id`.
 *   - inputs validated against the frontmatter schema at the write
 *     boundary so a bad input can't land malformed YAML on disk.
 */

import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import {
  RecurrenceSchema,
  TaskFrontmatterSchema,
  type Recurrence,
  type Task,
  type TaskCreate,
  type TaskFrontmatter,
  type TaskListFilter,
  type TaskStatus,
  type TaskUpdate,
} from "./types.js";
import {
  computeNextFire,
  describeRecurrence,
  validateRecurrence,
} from "./recurrence.js";

// Reject malformed inputs at the write boundary so a bad PATCH can't
// land garbage on disk that the next `list()` then silently drops.
const NullableIso = z.string().datetime({ offset: true }).nullable();
const TaskCreateInputSchema = z.object({
  title: z.string().min(1).max(500),
  assignee: z.string().min(1),
  created_by: z.string().min(1),
  body: z.string().optional(),
  session_id: z.string().min(1).nullable().optional(),
  parent_id: z.string().min(1).nullable().optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  start_at: NullableIso.optional(),
  due_at: NullableIso.optional(),
  status: z
    .enum(["open", "in_progress", "blocked", "done", "canceled"])
    .optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
});
const TaskUpdateInputSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().optional(),
  status: z
    .enum(["open", "in_progress", "blocked", "done", "canceled"])
    .optional(),
  assignee: z.string().min(1).optional(),
  session_id: z.string().min(1).nullable().optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  start_at: NullableIso.optional(),
  due_at: NullableIso.optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
});

const TMP_PREFIX = ".task_";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const STALE_IN_PROGRESS_MS = 10 * 60 * 1000;

export class TaskStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "TaskStoreError";
  }
}

export type OnChangeFn = () => void;

function isoNow(): string {
  return new Date().toISOString();
}

// Track which files we've already warned about. `list()` runs on every
// poke / render, so without this a single broken file spams the log
// indefinitely. Cleared the moment a file parses successfully so the
// next failure (after edits) re-warns.
const warnedMalformed = new Set<string>();

function parseTaskFile(filePath: string): Task | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const { data, content } = matter(raw);
    const fm = TaskFrontmatterSchema.parse(data);
    warnedMalformed.delete(filePath);
    return { ...fm, body: content.trimStart() };
  } catch (e) {
    if (!warnedMalformed.has(filePath)) {
      warnedMalformed.add(filePath);
      console.warn(
        `Skipping malformed task file ${filePath}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return null;
  }
}

function serializeTask(task: Task): string {
  const { body, ...frontmatter } = task;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v === undefined) continue;
    cleaned[k] = v;
  }
  return matter.stringify(body ? `${body}\n` : "\n", cleaned);
}

export class TaskStore {
  private readonly inFlight = new Map<string, Promise<void>>();
  private onChange: OnChangeFn | null = null;

  constructor(readonly tasksDir: string) {}

  setOnChange(fn: OnChangeFn | null): void {
    this.onChange = fn;
  }

  filePath(id: string): string {
    if (!SAFE_ID.test(id)) {
      throw new TaskStoreError(
        "invalid_id",
        `Invalid task id ${JSON.stringify(id)}: must match ${SAFE_ID}`
      );
    }
    return path.join(this.tasksDir, `${id}.md`);
  }

  // ── Reads (sync, no mutex) ────────────────────────────────────────

  get(id: string): Task | null {
    if (!SAFE_ID.test(id)) return null;
    return parseTaskFile(this.filePath(id));
  }

  list(filter?: TaskListFilter): Task[] {
    if (!fs.existsSync(this.tasksDir)) return [];
    const entries = fs.readdirSync(this.tasksDir, { withFileTypes: true });
    const out: Task[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".")) continue;
      if (!entry.name.endsWith(".md")) continue;
      const t = parseTaskFile(path.join(this.tasksDir, entry.name));
      if (!t) continue;
      if (!matchesFilter(t, filter)) continue;
      out.push(t);
    }
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return out;
  }

  byAssignee(agentId: string): Task[] {
    return this.list({ assignee: agentId });
  }

  byCreator(agentId: string): Task[] {
    return this.list({ created_by: agentId });
  }

  byParent(parentId: string): Task[] {
    return this.list({ parent_id: parentId });
  }

  dependentsOf(id: string): Task[] {
    return this.list().filter((t) => t.depends_on.includes(id));
  }

  /** Tasks bound to `sessionId` in queue order (deps + start_at + created_at). */
  queueFor(sessionId: string, now: Date = new Date()): Task[] {
    const all = this.list();
    const byId = new Map(all.map((t) => [t.id, t]));
    const sessionTasks = all.filter((t) => t.session_id === sessionId);
    const eligible = sessionTasks.filter((t) =>
      isQueueEligible(t, byId, now)
    );
    return eligible.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** Top of `queueFor` excluding already in_progress / done / canceled. */
  nextEligibleFor(sessionId: string, now: Date = new Date()): Task | null {
    const queue = this.queueFor(sessionId, now);
    const head = queue.find(
      (t) => t.status === "open" || t.status === "blocked"
    );
    return head ?? null;
  }

  // ── Writes ────────────────────────────────────────────────────────

  async create(input: TaskCreate): Promise<Task> {
    const parsed = TaskCreateInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new TaskStoreError(
        "invalid_input",
        `Invalid task create input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      );
    }
    input = parsed.data as TaskCreate;
    const id = randomUUID();
    return this.withMutex(id, async () => {
      const all = this.list();
      const byId = new Map(all.map((t) => [t.id, t]));

      // Validate deps exist + no cycle (the new id can't be in `byId`,
      // but check transitively against the new task's deps).
      const deps = input.depends_on ?? [];
      this.assertDepsExist(deps, byId);
      this.assertNoCycle(id, deps, byId);

      // Validate parent exists if set.
      if (input.parent_id && !byId.has(input.parent_id)) {
        throw new TaskStoreError(
          "unknown_parent",
          `parent_id ${JSON.stringify(input.parent_id)} not found`
        );
      }

      const nowDate = new Date();
      const now = nowDate.toISOString();

      // Recurrence semantic validation (zod handled shape; this catches
      // expr-with-no-future-runs, until-in-past, etc.).
      const recurrence = input.recurrence ?? null;
      if (recurrence) {
        const v = validateRecurrence(recurrence, nowDate);
        if (!v.ok) {
          throw new TaskStoreError("invalid_input", v.message);
        }
      }

      const explicitStatus = input.status ?? "open";
      const status = this.computeAutoStatus(deps, explicitStatus, byId);

      // Reject creating directly as in_progress if another in-progress
      // task already owns this session.
      if (
        status === "in_progress" &&
        input.session_id &&
        all.some(
          (t) => t.session_id === input.session_id && t.status === "in_progress"
        )
      ) {
        throw new TaskStoreError(
          "session_busy",
          `Another task is already in_progress in session ${input.session_id}`
        );
      }

      // First-fire start_at default for recurring tasks: cron honors the
      // schedule; interval fires immediately.
      let startAt: string | null;
      if (input.start_at !== undefined) {
        startAt = input.start_at;
      } else if (recurrence) {
        if (recurrence.kind === "cron") {
          const next = computeNextFire(recurrence, nowDate, 0);
          startAt = next ? next.toISOString() : null;
        } else {
          startAt = now;
        }
      } else {
        startAt = null;
      }

      const task: Task = {
        id,
        title: input.title,
        status,
        assignee: input.assignee,
        session_id: input.session_id ?? null,
        created_by: input.created_by,
        parent_id: input.parent_id ?? null,
        depends_on: deps,
        start_at: startAt,
        due_at: input.due_at ?? null,
        created_at: now,
        updated_at: now,
        closed_at: null,
        recurrence,
        runs: 0,
        last_run_at: null,
        body: input.body ?? "",
      };

      await this.writeFile(task);
      this.fireOnChange();
      return task;
    });
  }

  async update(id: string, patch: TaskUpdate): Promise<Task> {
    const parsed = TaskUpdateInputSchema.safeParse(patch);
    if (!parsed.success) {
      throw new TaskStoreError(
        "invalid_input",
        `Invalid task update input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      );
    }
    patch = parsed.data as TaskUpdate;
    return this.withMutex(id, async () => {
      const existing = this.get(id);
      if (!existing) {
        throw new TaskStoreError("not_found", `Task ${id} not found`);
      }

      const all = this.list();
      const byId = new Map(all.map((t) => [t.id, t]));

      // Reassignment automatically clears session_id (the new
      // assignee's sessions are different) — unless the same call also
      // sets session_id explicitly.
      const reassigning =
        patch.assignee !== undefined && patch.assignee !== existing.assignee;
      const explicitSession = Object.prototype.hasOwnProperty.call(
        patch,
        "session_id"
      );

      let nextSessionId = existing.session_id;
      if (explicitSession) {
        nextSessionId = patch.session_id ?? null;
      } else if (reassigning) {
        nextSessionId = null;
      }

      const nextDeps = patch.depends_on ?? existing.depends_on;
      if (patch.depends_on) {
        this.assertDepsExist(patch.depends_on, byId);
        this.assertNoCycle(id, patch.depends_on, byId);
      }

      const requestedStatus = patch.status ?? existing.status;
      const isClosing =
        (requestedStatus === "done" || requestedStatus === "canceled") &&
        existing.status !== requestedStatus;

      // Auto blocked/open only applies to non-terminal target statuses.
      let nextStatus: TaskStatus;
      if (
        requestedStatus === "done" ||
        requestedStatus === "canceled" ||
        requestedStatus === "in_progress"
      ) {
        nextStatus = requestedStatus;
      } else {
        nextStatus = this.computeAutoStatus(nextDeps, requestedStatus, byId);
      }

      // At-most-one-in_progress per session.
      if (nextStatus === "in_progress" && nextSessionId) {
        const conflict = all.find(
          (t) =>
            t.id !== id &&
            t.session_id === nextSessionId &&
            t.status === "in_progress"
        );
        if (conflict) {
          throw new TaskStoreError(
            "session_busy",
            `Session ${nextSessionId} already has an in_progress task (${conflict.id})`
          );
        }
      }

      // Block transitions to in_progress when deps aren't satisfied.
      if (
        nextStatus === "in_progress" &&
        !depsSatisfied(nextDeps, byId, id)
      ) {
        throw new TaskStoreError(
          "deps_unsatisfied",
          `Cannot start task ${id}: not all dependencies are done`
        );
      }

      // Effective recurrence after this patch — used for self-reset
      // decision and persisted on the task. `null` strips recurrence.
      const effectiveRecurrence: Recurrence | null =
        patch.recurrence !== undefined
          ? patch.recurrence
          : existing.recurrence ?? null;
      if (
        patch.recurrence !== undefined &&
        patch.recurrence !== null
      ) {
        const v = validateRecurrence(patch.recurrence, new Date());
        if (!v.ok) {
          throw new TaskStoreError("invalid_input", v.message);
        }
      }

      const nowDate = new Date();
      const now = nowDate.toISOString();
      let next: Task = {
        ...existing,
        title: patch.title ?? existing.title,
        body: patch.body ?? existing.body,
        status: nextStatus,
        assignee: patch.assignee ?? existing.assignee,
        session_id: nextSessionId,
        depends_on: nextDeps,
        start_at:
          patch.start_at !== undefined ? patch.start_at : existing.start_at,
        due_at: patch.due_at !== undefined ? patch.due_at : existing.due_at,
        updated_at: now,
        closed_at:
          nextStatus === "done" || nextStatus === "canceled"
            ? existing.closed_at ?? now
            : null,
        recurrence: effectiveRecurrence,
        runs: existing.runs ?? 0,
        last_run_at: existing.last_run_at ?? null,
      };

      // Self-reset on successful completion of a recurring task.
      // Canceled is the kill switch — never resets. Blocked / errored
      // turns leave the task blocked (scheduler set it that way) so a
      // failing recurring task doesn't loop forever.
      let didReset = false;
      if (
        isClosing &&
        nextStatus === "done" &&
        effectiveRecurrence
      ) {
        // Every successful done counts as a completion, whether or not
        // it produces a future fire — so `count: N` yields exactly N.
        const completedRuns = next.runs + 1;
        next = { ...next, runs: completedRuns, last_run_at: now };

        // Always advance past the current scheduled time. Without this,
        // a cron like "0 0 * * *" marked done before its first fire
        // would compute the same start_at again.
        const startAtMs = next.start_at ? Date.parse(next.start_at) : NaN;
        const fromMs = Math.max(
          nowDate.getTime(),
          Number.isFinite(startAtMs) ? startAtMs + 1 : 0
        );
        const nextFire = computeNextFire(
          effectiveRecurrence,
          new Date(fromMs),
          completedRuns
        );
        if (nextFire) {
          const resetSessionId =
            effectiveRecurrence.session === "fresh"
              ? null
              : next.session_id;
          // Re-evaluate auto-blocked against deps for the reset open
          // status — a recurring task whose deps regressed should sit
          // blocked, not open.
          const resetStatus = this.computeAutoStatus(nextDeps, "open", byId);
          next = {
            ...next,
            status: resetStatus,
            start_at: nextFire.toISOString(),
            closed_at: null,
            session_id: resetSessionId,
          };
          didReset = true;
        }
      }

      await this.writeFile(next);

      // Dependents only unblock on a real terminal "done". A recurring
      // task that self-reset isn't actually done — it's pending its
      // next fire — so dependents must keep waiting.
      if (isClosing && nextStatus === "done" && !didReset) {
        await this.unblockDependents(next.id, byId);
      }

      this.fireOnChange();
      return next;
    });
  }

  async delete(id: string, opts?: { force?: boolean }): Promise<void> {
    return this.withMutex(id, async () => {
      const existing = this.get(id);
      if (!existing) {
        throw new TaskStoreError("not_found", `Task ${id} not found`);
      }
      const dependents = this.dependentsOf(id);
      if (dependents.length > 0 && !opts?.force) {
        throw new TaskStoreError(
          "has_dependents",
          `Task ${id} has ${dependents.length} dependent(s). Pass force to cascade.`
        );
      }
      try {
        await fsp.unlink(this.filePath(id));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (opts?.force) {
        for (const dep of dependents) {
          // Recurse — each dependent may itself have dependents.
          try {
            await this.delete(dep.id, { force: true });
          } catch (e) {
            if (
              !(e instanceof TaskStoreError && e.code === "not_found")
            ) {
              throw e;
            }
          }
        }
      }
      this.fireOnChange();
    });
  }

  /**
   * Restart sweep: any task `in_progress` whose `updated_at` is older
   * than the staleness threshold is reset to `open`. Returns the ids
   * that were reset.
   */
  async sweepStale(now: Date = new Date()): Promise<string[]> {
    const stale = this.list({ status: "in_progress" }).filter((t) => {
      const updated = Date.parse(t.updated_at);
      return Number.isFinite(updated) && now.getTime() - updated > STALE_IN_PROGRESS_MS;
    });
    const reset: string[] = [];
    for (const t of stale) {
      try {
        await this.update(t.id, { status: "open" });
        reset.push(t.id);
      } catch (e) {
        console.warn(
          `sweepStale: failed to reset ${t.id}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    return reset;
  }

  /**
   * System-prompt block for an agent. `sessionExistsFn` lets the caller
   * treat tasks bound to a deleted session as if they were unbound.
   */
  renderForPrompt(
    agentId: string,
    currentSessionId: string,
    sessionExistsFn: (sid: string) => boolean,
    now: Date = new Date()
  ): string {
    const all = this.list();
    const byId = new Map(all.map((t) => [t.id, t]));
    const mine = all.filter((t) => t.assignee === agentId);
    const createdByMe = all.filter(
      (t) =>
        t.created_by === agentId &&
        t.assignee !== agentId &&
        t.status !== "done" &&
        t.status !== "canceled"
    );

    const inThisSession = mine.filter(
      (t) => t.session_id === currentSessionId
    );

    const active = inThisSession.filter((t) => t.status === "in_progress");
    const queuedHere = inThisSession
      .filter(
        (t) =>
          t.status === "open" &&
          depsSatisfied(t.depends_on, byId) &&
          !isFutureStart(t.start_at, now)
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const scheduledLater = inThisSession
      .filter((t) => t.status === "open" && isFutureStart(t.start_at, now))
      .sort((a, b) =>
        (a.start_at ?? "").localeCompare(b.start_at ?? "")
      );
    const blocked = inThisSession.filter((t) => t.status === "blocked");

    const otherSessions = mine.filter((t) => {
      if (t.session_id === currentSessionId) return false;
      if (t.status === "done" || t.status === "canceled") return false;
      if (!t.session_id) return false;
      return sessionExistsFn(t.session_id);
    });

    const sections: string[] = [];

    if (active.length > 0) {
      sections.push(
        renderSection("Active in this session (currently working)", active, (t) => {
          const due = t.due_at ? ` (due ${t.due_at})` : "";
          return `- [${t.id}]${due} ${t.title}${recurrenceTag(t)}`;
        })
      );
    }
    if (queuedHere.length > 0) {
      sections.push(
        renderSection(
          "Queued in this session (next up, in order)",
          queuedHere,
          (t) => `- [${t.id}] ${t.title}${recurrenceTag(t)}`
        )
      );
    }
    if (scheduledLater.length > 0) {
      sections.push(
        renderSection(
          "Scheduled later (in this session, starts at T)",
          scheduledLater,
          (t) =>
            `- [${t.id}] starts ${t.start_at} — ${t.title}${recurrenceTag(t)}`
        )
      );
    }
    if (blocked.length > 0) {
      sections.push(
        renderSection("Blocked on dependencies", blocked, (t) => {
          const unmet = t.depends_on.filter((d) => {
            const dep = byId.get(d);
            return !dep || dep.status !== "done";
          });
          return `- [${t.id}] ${t.title}${recurrenceTag(t)} — waiting on [${unmet.join(", ")}]`;
        })
      );
    }
    if (otherSessions.length > 0) {
      sections.push(
        renderSection(
          "In another session (read-only awareness — don't re-handle)",
          otherSessions,
          (t) =>
            `- [${t.id}] ${t.title}${recurrenceTag(t)} — bound to session ${t.session_id}`
        )
      );
    }
    if (createdByMe.length > 0) {
      sections.push(
        renderSection(
          "Created by me, assigned to others",
          createdByMe,
          (t) =>
            `- [${t.id}] ${t.title}${recurrenceTag(t)} — assignee ${t.assignee}, status ${t.status}`
        )
      );
    }

    if (sections.length === 0) return "";
    return `${sections.join("\n\n")}\n\nNOTE: snapshot from session start. Call task_list for fresh state.`;
  }

  // ── Internals ─────────────────────────────────────────────────────

  private assertDepsExist(
    deps: string[],
    byId: Map<string, Task>
  ): void {
    const missing = deps.filter((d) => !byId.has(d));
    if (missing.length > 0) {
      throw new TaskStoreError(
        "unknown_deps",
        `Unknown dependency id(s): ${missing.join(", ")}`
      );
    }
  }

  private assertNoCycle(
    selfId: string,
    deps: string[],
    byId: Map<string, Task>
  ): void {
    // DFS — does any path from a dep land back on selfId?
    const visited = new Set<string>();
    const stack = [...deps];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === selfId) {
        throw new TaskStoreError(
          "cycle",
          `Cycle detected in depends_on graph involving ${selfId}`
        );
      }
      if (visited.has(cur)) continue;
      visited.add(cur);
      const node = byId.get(cur);
      if (!node) continue;
      for (const d of node.depends_on) stack.push(d);
    }
  }

  private computeAutoStatus(
    deps: string[],
    requested: TaskStatus,
    byId: Map<string, Task>
  ): TaskStatus {
    if (requested === "done" || requested === "canceled") return requested;
    // Explicit `blocked` is honored — the scheduler uses it to park
    // failed turns, and we don't want a retry loop where the auto-correct
    // immediately flips it back to a runnable status.
    if (requested === "blocked") return requested;
    if (deps.length === 0) return requested;
    return depsSatisfied(deps, byId) ? "open" : "blocked";
  }

  private async unblockDependents(
    doneId: string,
    byIdSnapshot: Map<string, Task>
  ): Promise<void> {
    // Use a fresh read — `byIdSnapshot` predates this update.
    const fresh = this.list();
    const byId = new Map(fresh.map((t) => [t.id, t]));
    // Make sure the now-done task is reflected so depsSatisfied sees it.
    const closedNow = byId.get(doneId);
    if (closedNow) byId.set(doneId, { ...closedNow, status: "done" });
    void byIdSnapshot;

    for (const dep of fresh) {
      if (!dep.depends_on.includes(doneId)) continue;
      if (dep.status !== "blocked") continue;
      if (!depsSatisfied(dep.depends_on, byId)) continue;
      // Mutex-guarded write — re-enter via update() but skip
      // recursive fan-out since the close that triggered this is
      // already fanning out at the same level.
      try {
        await this.withMutex(dep.id, async () => {
          const cur = this.get(dep.id);
          if (!cur || cur.status !== "blocked") return;
          if (!depsSatisfied(cur.depends_on, byId)) return;
          const next: Task = {
            ...cur,
            status: "open",
            updated_at: isoNow(),
          };
          await this.writeFile(next);
        });
      } catch (e) {
        console.warn(
          `unblockDependents: failed for ${dep.id}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  private async writeFile(task: Task): Promise<void> {
    const file = this.filePath(task.id);
    const dir = path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `${TMP_PREFIX}${randomBytes(8).toString("hex")}.tmp`
    );
    let fh: fsp.FileHandle | null = null;
    try {
      fh = await fsp.open(tmp, "w");
      await fh.writeFile(serializeTask(task), "utf-8");
      await fh.sync();
      await fh.close();
      fh = null;
      await fsp.rename(tmp, file);
    } catch (e) {
      if (fh) {
        try {
          await fh.close();
        } catch {
          // ignore
        }
      }
      try {
        await fsp.unlink(tmp);
      } catch {
        // best-effort cleanup
      }
      throw e;
    }
  }

  private async withMutex<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prev = this.inFlight.get(id) ?? Promise.resolve();
    const result = prev.then(work, work);
    this.inFlight.set(
      id,
      result.then(
        () => undefined,
        () => undefined
      )
    );
    return result;
  }

  private fireOnChange(): void {
    if (!this.onChange) return;
    try {
      this.onChange();
    } catch (e) {
      console.warn(
        `TaskStore onChange threw: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}

// ── Pure helpers ────────────────────────────────────────────────────

function isFutureStart(startAt: string | null, now: Date): boolean {
  if (!startAt) return false;
  const t = Date.parse(startAt);
  if (!Number.isFinite(t)) return false;
  return t > now.getTime();
}

function depsSatisfied(
  deps: string[],
  byId: Map<string, TaskFrontmatter>,
  ignoreId?: string
): boolean {
  for (const d of deps) {
    if (d === ignoreId) continue;
    const dep = byId.get(d);
    if (!dep) return false;
    if (dep.status !== "done") return false;
  }
  return true;
}

function isQueueEligible(
  task: Task,
  byId: Map<string, Task>,
  now: Date
): boolean {
  if (task.status === "done" || task.status === "canceled") return false;
  if (!depsSatisfied(task.depends_on, byId, task.id)) return false;
  if (isFutureStart(task.start_at, now)) return false;
  return true;
}

function matchesFilter(task: Task, filter?: TaskListFilter): boolean {
  if (!filter) return true;
  if (filter.assignee !== undefined && task.assignee !== filter.assignee)
    return false;
  if (filter.created_by !== undefined && task.created_by !== filter.created_by)
    return false;
  if (filter.session_id !== undefined && task.session_id !== filter.session_id)
    return false;
  if (filter.parent_id !== undefined && task.parent_id !== filter.parent_id)
    return false;
  if (filter.status !== undefined) {
    const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!wanted.includes(task.status)) return false;
  }
  return true;
}

function renderSection<T>(
  title: string,
  items: T[],
  fmt: (t: T) => string
): string {
  return `${title}:\n${items.map(fmt).join("\n")}`;
}

function recurrenceTag(t: Task): string {
  if (!t.recurrence) return "";
  return ` (${describeRecurrence(t.recurrence)}, ran ${t.runs}×)`;
}
