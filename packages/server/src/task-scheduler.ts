/**
 * TaskScheduler — turns task state changes into autonomous agent turns.
 *
 * Uses `croner` for the wake primitive. One `Cron` per future-dated
 * task; tasks without `start_at` (or already due) are handled by the
 * immediate path on `poke()`. When recurring tasks land later, the
 * same `Cron` accepts a cron expression — no new wake mechanism.
 *
 * Concurrency:
 *   - Per-agent serialization. Each agent has at most one in-flight
 *     turn; agents run in parallel. The `chains` map values are
 *     settle-only (never reject) so a thrown turn doesn't poison the
 *     next.
 *   - At-most-one-in_progress-per-session is enforced upstream by
 *     `TaskStore.update`; the scheduler doesn't double-check.
 *
 * Persistence:
 *   - Tasks are markdown files. Restart sweep resets stale in_progress
 *     tasks (older than 10 min) back to open so the queue picks them up.
 */

import { Cron } from "croner";
import type { TaskStore, Task } from "@openacme/tasks";
import { TaskStoreError } from "@openacme/tasks";
import { AutonomousTurnTimeout } from "@openacme/agent-core";
import type { SessionStore } from "@openacme/db";
import type { AgentManager } from "./agent-manager.js";

const POKE_DEBOUNCE_MS = 50;

export interface TaskSchedulerOptions {
  taskStore: TaskStore;
  sessionStore: SessionStore;
  agentManager: AgentManager;
  /** Override the wall clock — test seam. */
  now?: () => Date;
}

export class TaskScheduler {
  private readonly taskStore: TaskStore;
  private readonly sessionStore: SessionStore;
  private readonly agentManager: AgentManager;
  private readonly now: () => Date;

  /** One Cron per task awaiting a future start_at. */
  private armed = new Map<string, Cron>();
  private chains = new Map<string, Promise<void>>();
  /** Task ids currently enqueued or executing — avoid double-enqueue across rapid ticks. */
  private pending = new Set<string>();
  private pokeTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(opts: TaskSchedulerOptions) {
    this.taskStore = opts.taskStore;
    this.sessionStore = opts.sessionStore;
    this.agentManager = opts.agentManager;
    this.now = opts.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      const reset = await this.taskStore.sweepStale(this.now());
      if (reset.length > 0) {
        console.log(
          `TaskScheduler: reset ${reset.length} stale in-progress task(s) on startup`
        );
      }
    } catch (e) {
      console.warn(
        `TaskScheduler: startup sweep failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    await this.tick();
  }

  stop(): void {
    this.stopped = true;
    for (const cron of this.armed.values()) cron.stop();
    this.armed.clear();
    if (this.pokeTimer) {
      clearTimeout(this.pokeTimer);
      this.pokeTimer = undefined;
    }
  }

  /** Re-evaluate the schedule. Coalesces bursty calls within 50ms. */
  poke(): void {
    if (this.stopped) return;
    if (this.pokeTimer) return;
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = undefined;
      if (this.stopped) return;
      this.tick().catch((e) => {
        console.warn(
          `TaskScheduler: tick failed: ${e instanceof Error ? e.message : String(e)}`
        );
      });
    }, POKE_DEBOUNCE_MS);
    if (typeof this.pokeTimer.unref === "function") this.pokeTimer.unref();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.stopped) return;

    const now = this.now();
    const all = this.taskStore.list();

    // Step 1: lazily allocate sessions for ready unbound tasks.
    for (const t of all) {
      if (t.session_id) continue;
      if (t.status !== "open") continue;
      if (isFutureStart(t.start_at, now)) continue;
      if (!this.depsSatisfied(t)) continue;
      try {
        const session = this.sessionStore.create(t.assignee, {
          title: t.title.slice(0, 80),
        });
        await this.taskStore.update(t.id, { session_id: session.id });
      } catch (e) {
        console.warn(
          `TaskScheduler: failed to bind session for task ${t.id}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    // Step 2: pick up to one ready task per session and run.
    const refreshed = this.taskStore.list();
    const sessions = new Set(
      refreshed
        .map((t) => t.session_id)
        .filter((s): s is string => s !== null)
    );
    for (const sessionId of sessions) {
      const head = this.taskStore.nextEligibleFor(sessionId, now);
      if (!head) continue;
      if (head.status === "in_progress") continue;
      if (this.pending.has(head.id)) continue;
      if (!this.depsSatisfied(head)) continue;
      if (isFutureStart(head.start_at, now)) continue;
      this.enqueueTurn(head);
    }

    // Step 3: reconcile future-dated cron arms.
    this.reconcileArmed(refreshed, now);
  }

  private reconcileArmed(tasks: Task[], now: Date): void {
    const wanted = new Map<string, Date>();
    for (const t of tasks) {
      if (t.status === "done" || t.status === "canceled") continue;
      if (!t.start_at) continue;
      const at = new Date(t.start_at);
      if (Number.isNaN(at.getTime())) continue;
      if (at.getTime() <= now.getTime()) continue;
      wanted.set(t.id, at);
    }

    // Drop arms that are no longer wanted, or whose target time changed.
    // Croner has no reschedule — stop + recreate.
    for (const [id, cron] of this.armed) {
      const want = wanted.get(id);
      if (!want) {
        cron.stop();
        this.armed.delete(id);
        continue;
      }
      const armedAt = cron.getOnce();
      if (!armedAt || armedAt.getTime() !== want.getTime()) {
        cron.stop();
        this.armed.delete(id);
      }
    }

    // Add arms for ids not yet covered.
    for (const [id, at] of wanted) {
      if (this.armed.has(id)) continue;
      const cron = new Cron(
        at,
        { unref: true, catch: true, maxRuns: 1 },
        () => {
          this.armed.delete(id);
          if (this.stopped) return;
          this.tick().catch((e) => {
            console.warn(
              `TaskScheduler: armed tick for ${id} failed: ${e instanceof Error ? e.message : String(e)}`
            );
          });
        }
      );
      this.armed.set(id, cron);
    }
  }

  private enqueueTurn(task: Task): void {
    const agentId = task.assignee;
    const sessionId = task.session_id;
    if (!sessionId) return;
    this.pending.add(task.id);
    const prev = this.chains.get(agentId) ?? Promise.resolve();
    const work = async () => {
      try {
        await this.runTurn(task.id, sessionId, agentId);
      } finally {
        this.pending.delete(task.id);
      }
    };
    const next = prev.then(work, work);
    this.chains.set(
      agentId,
      next.then(
        () => undefined,
        () => undefined
      )
    );
  }

  private async runTurn(
    taskId: string,
    sessionId: string,
    agentId: string
  ): Promise<void> {
    if (this.stopped) return;
    const task = this.taskStore.get(taskId);
    if (!task) return;
    if (task.status !== "open") return;
    if (task.session_id !== sessionId) return;

    try {
      await this.taskStore.update(taskId, { status: "in_progress" });
    } catch (e) {
      if (
        e instanceof TaskStoreError &&
        (e.code === "session_busy" || e.code === "deps_unsatisfied")
      ) {
        return;
      }
      throw e;
    }

    let agent;
    try {
      agent = this.agentManager.getAgent(agentId);
    } catch (e) {
      console.warn(
        `TaskScheduler: agent ${agentId} not found for task ${taskId}: ${e instanceof Error ? e.message : String(e)}`
      );
      await this.safeUpdate(taskId, { status: "open" });
      return;
    }

    try {
      await agent.runAutonomous({ sessionId, taskId });
    } catch (e) {
      if (e instanceof AutonomousTurnTimeout) {
        const cur = this.taskStore.get(taskId);
        const note = `\n\n> [scheduler] turn timed out at ${this.now().toISOString()}`;
        await this.safeUpdate(taskId, {
          status: "blocked",
          body: (cur?.body ?? "") + note,
        });
        return;
      }
      console.warn(
        `TaskScheduler: turn for ${taskId} failed: ${e instanceof Error ? e.message : String(e)}`
      );
      const cur = this.taskStore.get(taskId);
      const note = `\n\n> [scheduler] turn errored: ${e instanceof Error ? e.message : String(e)}`;
      await this.safeUpdate(taskId, {
        status: "blocked",
        body: (cur?.body ?? "") + note,
      });
      return;
    }
  }

  private async safeUpdate(
    id: string,
    patch: Parameters<TaskStore["update"]>[1]
  ): Promise<void> {
    try {
      await this.taskStore.update(id, patch);
    } catch (e) {
      console.warn(
        `TaskScheduler: failed safeUpdate for ${id}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private depsSatisfied(t: Task): boolean {
    if (t.depends_on.length === 0) return true;
    return t.depends_on.every((dep) => {
      const d = this.taskStore.get(dep);
      return d?.status === "done";
    });
  }
}

function isFutureStart(startAt: string | null, now: Date): boolean {
  if (!startAt) return false;
  const t = Date.parse(startAt);
  if (!Number.isFinite(t)) return false;
  return t > now.getTime();
}
