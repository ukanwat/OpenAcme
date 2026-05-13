/**
 * Home page payload + workforce summary stream.
 *
 * `GET /api/home` returns the three-bucket session summary (Waiting /
 * Running / Idle) the home page renders. Combines task state, session
 * activity, and unresolved `ping_user` events into a single payload so
 * the home view doesn't have to fan out to N endpoints.
 *
 * The accompanying SSE stream lives in `routes/streams.ts` as
 * `/api/home/stream` — workforce-wide envelope fan-out from the
 * broadcaster.
 */

import type { Hono } from "hono";
import type { AgentManager } from "../agent-manager.js";

export interface SessionSummary {
  sessionId: string;
  agentId: string;
  agentName: string;
  title: string | null;
  /** Human-readable status label. Values: "waiting" | "running" | "idle". */
  status: "waiting" | "running" | "idle";
  /** Current in_progress task title for this session, if any. */
  currentTaskTitle: string | null;
  /** Count of non-terminal (open / in_progress / blocked) tasks bound here. */
  pendingTaskCount: number;
  /** Last activity unix-seconds. Driven by session.updated_at. */
  lastActivity: number;
  /** Unix-seconds the agent set via `sleep`, or null when default cadence. */
  nextCheckAt: number | null;
  /** When status === "waiting", the agent's ping message. */
  pingMessage?: string;
}

export interface HomePayload {
  waiting: SessionSummary[];
  running: SessionSummary[];
  idle: SessionSummary[];
}

export function registerHomeRoutes(app: Hono, manager: AgentManager): void {
  app.get("/api/home", (c) => {
    const payload = buildHomePayload(manager);
    return c.json(payload);
  });
}

export function buildHomePayload(manager: AgentManager): HomePayload {
  // Sessions: leaf nodes across the workforce (excludes compression
  // parents). The list is cross-agent so we see every agent's work in
  // one place.
  const sessions = manager.sessionStore.listAllActive();
  const agentNames = new Map<string, string>();
  for (const def of manager.listAgents()) {
    agentNames.set(def.id, def.name);
  }

  // Pings (waiting): map sessionId → ping payload. The query already
  // filters to unresolved (no user message after the event).
  const pings = manager.eventStore.unresolvedPingsBySession();
  const pingBySession = new Map(pings.map((p) => [p.sessionId, p]));

  // Currently-running sessions: from the scheduler. Stable getter
  // exposes the internal Set; falling back to inspection if absent.
  const running = manager.taskScheduler.runningSessionIds();
  const runningSet = new Set(running);

  // Group tasks by session_id for O(1) lookup.
  const allTasks = manager.taskStore.list();
  const tasksBySession = new Map<string, typeof allTasks>();
  for (const t of allTasks) {
    if (!t.session_id) continue;
    let bucket = tasksBySession.get(t.session_id);
    if (!bucket) {
      bucket = [];
      tasksBySession.set(t.session_id, bucket);
    }
    bucket.push(t);
  }

  const waiting: SessionSummary[] = [];
  const runningOut: SessionSummary[] = [];
  const idle: SessionSummary[] = [];

  for (const session of sessions) {
    const tasks = tasksBySession.get(session.id) ?? [];
    // Hide sessions whose every task is terminal — they've settled.
    // Operator-initiated chat sessions with no task at all stay
    // visible until they're explicitly deleted (they're the user's
    // ad-hoc threads, not autonomous-driven work).
    const nonTerminal = tasks.filter(
      (t) => t.status !== "done" && t.status !== "canceled"
    );
    if (tasks.length > 0 && nonTerminal.length === 0) continue;

    const inProgress = nonTerminal.find((t) => t.status === "in_progress");
    const ping = pingBySession.get(session.id);

    const summary: SessionSummary = {
      sessionId: session.id,
      agentId: session.agentId,
      agentName: agentNames.get(session.agentId) ?? session.agentId,
      title: session.title,
      status: ping
        ? "waiting"
        : runningSet.has(session.id)
          ? "running"
          : "idle",
      currentTaskTitle: inProgress?.title ?? null,
      pendingTaskCount: nonTerminal.length,
      lastActivity: session.updatedAt,
      nextCheckAt: session.nextCheckAt ?? null,
      pingMessage: ping?.message,
    };

    if (summary.status === "waiting") waiting.push(summary);
    else if (summary.status === "running") runningOut.push(summary);
    else idle.push(summary);
  }

  // Waiting: oldest unanswered first (oldest createdAt of ping).
  waiting.sort((a, b) => {
    const pa = pingBySession.get(a.sessionId)?.createdAt ?? 0;
    const pb = pingBySession.get(b.sessionId)?.createdAt ?? 0;
    return pa - pb;
  });
  // Running + Idle: most recent activity first.
  runningOut.sort((a, b) => b.lastActivity - a.lastActivity);
  idle.sort((a, b) => b.lastActivity - a.lastActivity);

  return { waiting, running: runningOut, idle };
}
