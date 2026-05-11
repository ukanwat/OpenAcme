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
import type { TaskStore, Task, TaskEvent } from "@openacme/tasks";
import { AutonomousTurnTimeout } from "@openacme/agent-core";
import type { SessionStore } from "@openacme/db";
import type { AgentManager } from "./agent-manager.js";

const SESSION_WAKE_DEBOUNCE_MS = 7_000;
// Floor on the gap between two wakes on the same session. With pure
// event-driven scheduling (no periodic tick fallback), events that
// arrive while a session is rate-limited are QUEUED — they fire when
// the window opens. Originally 30s when the tick covered the gap; 10s
// now to keep latency tolerable for users.
const SESSION_MIN_WAKE_INTERVAL_MS = 10_000;

interface SessionWakeState {
  debounceTimer?: NodeJS.Timeout;
  lastWakeAt: number;
  /** An event arrived while a turn was running for this session.
   *  We re-schedule a wake in the turn's `finally` so the event
   *  doesn't get lost in the race between "event fires" and "turn
   *  ends + pendingSessions clears." */
  wakeRequestedDuringTurn?: boolean;
}

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
  /** Sessions currently enqueued or running — avoid double-enqueue across rapid ticks. */
  private pendingSessions = new Set<string>();
  /** Per-session wake bookkeeping for debounce + rate-limit. */
  private wakeBySession = new Map<string, SessionWakeState>();
  // Defaults to true: events that fire before `start()` are dropped so
  // they don't race with `startupSweep`. The sweep handles every task
  // present at boot via a single sequential pass; once `start()` flips
  // this to false, the event-driven path takes over.
  private stopped = true;

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
    await this.startupSweep();
  }

  stop(): void {
    this.stopped = true;
    for (const cron of this.armed.values()) cron.stop();
    this.armed.clear();
    for (const state of this.wakeBySession.values()) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
    }
    this.wakeBySession.clear();
  }

  /**
   * Reconcile cron arms for future-dated tasks. Called on any TaskStore
   * mutation (via `setOnChange`) to catch non-event-emitting changes
   * like a bare `start_at` update. Cheap — walks the task list, no
   * waking happens here.
   */
  reconcile(): void {
    if (this.stopped) return;
    this.reconcileArmed(this.taskStore.list(), this.now());
  }

  /**
   * React to a TaskStore event. Single unified path — no per-kind
   * routing. All events go through:
   *   1. Resolve the task. Skip terminal (done/canceled).
   *   2. If task has a future `start_at`, arm a cron and stop here —
   *      no wake until the time arrives.
   *   3. If the task is unbound, allocate a fresh session inline.
   *   4. Echo: skip if `event.actor === session.agentId` (self-action)
   *      AND the session existed before this event. Newly-allocated
   *      sessions never echo — they haven't done anything yet.
   *   5. Confirm the session still has non-terminal work
   *      (`hasAnyActive`); skip if not.
   *   6. Schedule the wake with `scheduleWake` — debounce coalesces
   *      bursts, rate-limit delays (does NOT drop) so busy sessions
   *      still hear about every event eventually.
   */
  async onEvent(event: TaskEvent): Promise<void> {
    if (this.stopped) return;
    const task = this.taskStore.get(event.taskId);
    if (!task) return;
    if (task.status === "done" || task.status === "canceled") return;
    if (isFutureStart(task.start_at, this.now())) {
      // Not ready yet — let croner handle the wake at the right time.
      this.reconcileArmed([task], this.now());
      return;
    }

    let sessionId = task.session_id;
    let isNewSession = false;
    if (!sessionId) {
      // Only allocate when the task is actually startable. Blocked
      // tasks wait for `dep_unblocked` (which fires another event
      // with the now-open task that will allocate then).
      if (task.status !== "open") return;
      if (!this.depsSatisfied(task)) return;
      try {
        const session = this.sessionStore.create(task.assignee, {
          title: task.title.slice(0, 80),
        });
        await this.taskStore.update(task.id, { session_id: session.id });
        sessionId = session.id;
        isNewSession = true;
      } catch (e) {
        console.warn(
          `TaskScheduler: failed to allocate session for ${task.id}: ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }
    }

    const session = this.sessionStore.get(sessionId);
    if (!session) {
      this.dropWakeState(sessionId);
      return;
    }

    if (
      !isNewSession &&
      event.actor &&
      event.actor === session.agentId
    ) {
      return;
    }

    if (!this.hasAnyActive(sessionId)) return;

    this.scheduleWake(sessionId);
  }

  /**
   * Schedule (or coalesce into an existing) wake for a session.
   * - First event in a quiet window → fires after the 7s debounce.
   * - Burst events arrive while a timer is in flight → coalesced
   *   (no new timer; they'll be visible in the prompt's Recent
   *   Activity once the existing timer fires).
   * - Session is rate-limited (woke recently) → the timer fires
   *   when the rate-limit window opens, not before. The event is
   *   QUEUED, not dropped.
   */
  private scheduleWake(sessionId: string): void {
    const state = this.getOrInitWakeState(sessionId);
    if (this.pendingSessions.has(sessionId)) {
      // A turn is running. Queue the wake to fire when it finishes.
      state.wakeRequestedDuringTurn = true;
      return;
    }
    if (state.debounceTimer) return;

    const nowMs = this.now().getTime();
    const sinceLast =
      state.lastWakeAt > 0 ? nowMs - state.lastWakeAt : Infinity;
    const rateLimitWait =
      sinceLast < SESSION_MIN_WAKE_INTERVAL_MS
        ? SESSION_MIN_WAKE_INTERVAL_MS - sinceLast
        : 0;
    const wait = Math.max(SESSION_WAKE_DEBOUNCE_MS, rateLimitWait);

    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = undefined;
      if (this.stopped) return;
      this.fireWake(sessionId);
    }, wait);
    if (typeof state.debounceTimer.unref === "function") {
      state.debounceTimer.unref();
    }
  }

  private fireWake(sessionId: string): void {
    if (this.pendingSessions.has(sessionId)) {
      // Lost the race to a concurrent turn — queue for after-turn retry.
      const state = this.getOrInitWakeState(sessionId);
      state.wakeRequestedDuringTurn = true;
      return;
    }
    if (!this.hasAnyActive(sessionId)) return;
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      this.dropWakeState(sessionId);
      return;
    }
    // Bump the rate-limit clock only when we actually fire a turn —
    // a no-op fireWake (session busy / no work) shouldn't count.
    const state = this.getOrInitWakeState(sessionId);
    state.lastWakeAt = this.now().getTime();
    this.enqueueTurn(sessionId, session.agentId);
  }

  private getOrInitWakeState(sessionId: string): SessionWakeState {
    let s = this.wakeBySession.get(sessionId);
    if (!s) {
      s = { lastWakeAt: 0 };
      this.wakeBySession.set(sessionId, s);
    }
    return s;
  }

  private dropWakeState(sessionId: string): void {
    const s = this.wakeBySession.get(sessionId);
    if (s?.debounceTimer) clearTimeout(s.debounceTimer);
    this.wakeBySession.delete(sessionId);
  }

  /**
   * Resolve which session should wake for an event. Bound tasks → that
   * session. Unbound tasks → null (caller handles inline allocation).
   * DON'T fall back to the assignee's most-recent session here — that
   * triggers self-echo for tasks an agent created in their own session.
   */
  private resolveTargetSession(event: TaskEvent): string | null {
    const task = this.taskStore.get(event.taskId);
    if (!task) return null;
    return task.session_id;
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * One-time startup pass. Runs at `start()`:
   *   - allocate sessions for any unbound, ready, open tasks that
   *     accumulated while we were down (sweepStale already flipped
   *     stale in_progress back to open);
   *   - arm crons for future-dated tasks;
   *   - schedule wakes for sessions that now have active work.
   * No periodic timer drives this — runtime wakes come from
   * `onEvent` (state changes) and croner (time-based).
   */
  private async startupSweep(): Promise<void> {
    const now = this.now();
    const all = this.taskStore.list();

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

    const refreshed = this.taskStore.list();
    this.reconcileArmed(refreshed, now);

    // Startup wakes fire immediately — no debounce coalescing needed
    // since we're processing the accumulated backlog, not a burst.
    const sessions = new Set(
      refreshed
        .map((t) => t.session_id)
        .filter((s): s is string => s !== null)
    );
    for (const sessionId of sessions) {
      if (this.pendingSessions.has(sessionId)) continue;
      if (!this.hasAnyActive(sessionId)) continue;
      const session = this.sessionStore.get(sessionId);
      if (!session) continue;
      const state = this.getOrInitWakeState(sessionId);
      state.lastWakeAt = this.now().getTime();
      this.enqueueTurn(sessionId, session.agentId);
    }
  }

  /**
   * Is there any non-terminal task in this session? Used for both
   * event-driven wakes and the startup sweep. The triggering signal
   * (event or startup) justifies attention; we just confirm there's
   * something for the agent to act on. Excludes done / canceled.
   */
  private hasAnyActive(sessionId: string): boolean {
    const tasks = this.taskStore.list({ session_id: sessionId });
    return tasks.some(
      (t) => t.status !== "done" && t.status !== "canceled"
    );
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
          this.fireArmed(id).catch((e) => {
            console.warn(
              `TaskScheduler: armed wake for ${id} failed: ${e instanceof Error ? e.message : String(e)}`
            );
          });
        }
      );
      this.armed.set(id, cron);
    }
  }

  /**
   * Croner fired — its task's `start_at` has arrived. Dispatch a wake
   * through the same allocate→schedule pipeline as events. No `actor`
   * to echo-check; the trigger is the wall clock.
   */
  private async fireArmed(taskId: string): Promise<void> {
    const task = this.taskStore.get(taskId);
    if (!task) return;
    if (task.status === "done" || task.status === "canceled") return;

    let sessionId = task.session_id;
    if (!sessionId) {
      try {
        const session = this.sessionStore.create(task.assignee, {
          title: task.title.slice(0, 80),
        });
        await this.taskStore.update(task.id, { session_id: session.id });
        sessionId = session.id;
      } catch (e) {
        console.warn(
          `TaskScheduler: armed alloc for ${task.id} failed: ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }
    }
    if (!this.hasAnyActive(sessionId)) return;
    this.scheduleWake(sessionId);
  }

  private enqueueTurn(sessionId: string, agentId: string): void {
    this.pendingSessions.add(sessionId);
    const prev = this.chains.get(agentId) ?? Promise.resolve();
    const work = async () => {
      try {
        await this.runTurn(sessionId, agentId);
      } finally {
        this.pendingSessions.delete(sessionId);
        // Any events that arrived during the turn requested a wake;
        // fire it now that the session is free.
        const state = this.wakeBySession.get(sessionId);
        if (state?.wakeRequestedDuringTurn) {
          state.wakeRequestedDuringTurn = false;
          this.scheduleWake(sessionId);
        }
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

  /**
   * Run one autonomous turn in the given session. The agent picks the
   * task itself; the scheduler is just the wake mechanism here. On
   * timeout/error we look up whichever task ended up `in_progress`
   * during the turn and park it as blocked with a `system:scheduler`
   * comment — that's our failure-attribution hook now that we don't
   * dispatch a specific task.
   */
  private async runTurn(
    sessionId: string,
    agentId: string
  ): Promise<void> {
    if (this.stopped) return;

    let agent;
    try {
      agent = this.agentManager.getAgent(agentId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // No specific task to attribute this to (the agent never ran). Log
      // and bail; the next tick will retry. If the agent stays missing
      // permanently, a human is the right escalation path — auto-blocking
      // every task assigned to a vanished agent would be too aggressive.
      console.warn(
        `TaskScheduler: agent ${agentId} not available for session ${sessionId}: ${msg}`
      );
      return;
    }

    try {
      await agent.runAutonomous({ sessionId });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isTimeout = e instanceof AutonomousTurnTimeout;
      if (!isTimeout) {
        console.warn(
          `TaskScheduler: turn in session ${sessionId} failed: ${message}`
        );
      }
      await this.parkInProgress(sessionId, {
        action: isTimeout ? "timeout" : "error",
        message: isTimeout
          ? `turn timed out at ${this.now().toISOString()}`
          : `turn errored at ${this.now().toISOString()}: ${message}`,
      });
    }
  }

  /**
   * After a failed turn, find the task the agent picked up (if any) and
   * park it as blocked with a system comment. With agent-driven
   * selection the scheduler can't pre-attribute failures to a task —
   * it has to look at the post-failure session state. If the agent
   * never picked anything (timed out before claiming, errored on
   * setup), there's nothing to park.
   */
  private async parkInProgress(
    sessionId: string,
    note: { action: "timeout" | "error"; message: string }
  ): Promise<void> {
    const inProg = this.taskStore.list({
      session_id: sessionId,
      status: "in_progress",
    });
    for (const task of inProg) {
      try {
        await this.taskStore.update(
          task.id,
          { status: "blocked" },
          { actor: "system:scheduler" }
        );
        await this.taskStore.addComment({
          taskId: task.id,
          author: "system:scheduler",
          kind: "system",
          body: `[${note.action}] ${note.message}`,
        });
      } catch (e) {
        console.warn(
          `TaskScheduler: parkInProgress failed for ${task.id}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
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
