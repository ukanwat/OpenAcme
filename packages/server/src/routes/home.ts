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
  /** Unix-seconds the agent set via `defer_session(duration)`, or
   *  null when no defer is active. The dispatcher's tick honours this
   *  for routine spawns; new inbox rows bypass it. */
  deferUntil: number | null;
  /** When status === "waiting", the agent's ping message. */
  pingMessage?: string;
}

export interface HomePayload {
  waiting: SessionSummary[];
  running: SessionSummary[];
  idle: SessionSummary[];
}

export interface MessageSearchHit {
  sessionId: string;
  agentId: string;
  agentName: string;
  sessionTitle: string | null;
  /** Which side of the conversation matched. */
  role: "user" | "assistant";
  /** ±60 chars around the first matched token, ellipsized at boundaries. */
  snippet: string;
  /** FTS5 bm25 rank — lower is better. */
  rank: number;
}

/**
 * Wrap user input as FTS5 prefix-with-AND expression. Each whitespace
 * token becomes a quoted prefix term so reserved syntax in raw input
 * can't unhinge the query. Empty → null (caller skips the call).
 */
function sanitizeFtsQuery(q: string): string | null {
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
}

/**
 * Pull ±contextChars around the first matched token. Tokens are matched
 * case-insensitive; the original casing is preserved in the output.
 */
function makeSnippet(content: string, q: string, contextChars = 60): string {
  const tokens = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return content.slice(0, 200);
  const lower = content.toLowerCase();
  let bestPos = -1;
  for (const t of tokens) {
    const p = lower.indexOf(t);
    if (p !== -1 && (bestPos === -1 || p < bestPos)) bestPos = p;
  }
  if (bestPos === -1) return content.slice(0, 200);
  const start = Math.max(0, bestPos - contextChars);
  const end = Math.min(content.length, bestPos + contextChars * 2);
  return (
    (start > 0 ? "…" : "") +
    content.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < content.length ? "…" : "")
  );
}

export function registerHomeRoutes(app: Hono, manager: AgentManager): void {
  app.get("/api/home", (c) => {
    const payload = buildHomePayload(manager);
    return c.json(payload);
  });

  // Message-body FTS for the Home page's search bar. Title/agent/ping
  // matching happens client-side over the home payload; this endpoint
  // covers content matches only. Returns enriched rows joined with
  // session + agent name so the client can render without an N+1.
  app.get("/api/messages/search", (c) => {
    const raw = c.req.query("q") ?? "";
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 20));
    const expr = sanitizeFtsQuery(raw);
    if (!expr) return c.json({ results: [] as MessageSearchHit[] });

    const rows = manager.messageStore.search(expr, limit);
    if (rows.length === 0) return c.json({ results: [] as MessageSearchHit[] });

    const agentNames = new Map<string, string>();
    for (const def of manager.listAgents()) {
      agentNames.set(def.id, def.name);
    }

    // FTS can return repeated sessions across multiple message hits.
    // Keep the best-ranked hit per session so result rows are 1:1 with
    // sessions and the operator gets variety, not three rows of one chat.
    const bestBySession = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      const cur = bestBySession.get(r.sessionId);
      if (!cur || r.rank < cur.rank) bestBySession.set(r.sessionId, r);
    }

    const results: MessageSearchHit[] = [];
    for (const row of bestBySession.values()) {
      const session = manager.sessionStore.get(row.sessionId);
      if (!session) continue;
      results.push({
        sessionId: row.sessionId,
        agentId: session.agentId,
        agentName: agentNames.get(session.agentId) ?? session.agentId,
        sessionTitle: session.title,
        role: row.role as "user" | "assistant",
        snippet: makeSnippet(row.content, raw),
        rank: row.rank,
      });
    }
    results.sort((a, b) => a.rank - b.rank);
    return c.json({ results });
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

  // Currently-running sessions: union of dispatcher-spawned turns and
  // interactive `/api/chat` turns. `dispatcher.runningSessionIds()`
  // unions both; the home view doesn't care which kind of turn it is.
  const running = manager.dispatcher.runningSessionIds();
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
    const nonTerminal = tasks.filter(
      (t) => t.status !== "done" && t.status !== "canceled"
    );

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
      deferUntil: session.deferUntil ?? null,
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
