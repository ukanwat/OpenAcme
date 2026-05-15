/**
 * In-memory per-session pub/sub for live updates to web clients.
 * Shared by the scheduler (session_state), event store (task_event),
 * both /api/chat and Agent.runAutonomous (ui_message_part chunks +
 * messages_appended for user/auto messages), and the SSE routes.
 *
 * Ring buffer (50 events per session, in `RING_CAPACITY`) backs the
 * SSE `Last-Event-ID` reconnect path so a brief network blip mid-stream
 * doesn't drop chunks. Older-than-buffer means the gap is silently
 * dropped — the client refetches history on reconnect.
 */

import { createLogger } from "@openacme/config/logger";

const log = createLogger("server.broadcaster");

export type SessionBroadcastEvent =
  | {
      kind: "ui_message_part";
      /** Raw UIMessage stream chunk (text-delta, tool-call, etc.) — same
       *  shape as what `result.toUIMessageStream` emits. The client
       *  consumes via `readUIMessageStream` to reassemble UIMessages. */
      part: unknown;
    }
  | {
      kind: "messages_appended";
      /** UIMessages just persisted to the message store. Used to push
       *  user-side messages to SSE subscribers (the SDK's UIMessage
       *  stream only carries assistant chunks, so user messages and
       *  the system-event prompt that runAutonomous prepends need
       *  their own broadcast pipe). The client `upsert`s by id so a
       *  redundant arrival from history-refetch is a no-op. */
      messages: Array<{
        id: string;
        role: "user" | "assistant";
        parts: unknown[];
        metadata?: unknown;
      }>;
    }
  | {
      kind: "session_state";
      state: "running" | "idle";
    }
  | {
      kind: "task_event";
      /** A TaskEventRow from the EventStore — already serialized form
       *  is fine since SSE wraps everything in JSON. The client
       *  interprets these to update home-page row state. */
      event: {
        id: string;
        taskId: string | null;
        sessionId: string | null;
        agentId: string;
        actor: string | null;
        kind: string;
        payload: string | null;
        createdAt: number;
      };
    };

export interface BroadcastEnvelope {
  /** Monotonic per-session sequence id. Used by SSE `Last-Event-ID`
   *  reconnects to replay missed events from the ring buffer. */
  seq: number;
  /** Wall-clock at broadcast time (unix ms). Useful for clients
   *  computing relative-time labels without re-querying. */
  ts: number;
  event: SessionBroadcastEvent;
}

type Listener = (env: BroadcastEnvelope) => void;

interface SessionState {
  listeners: Set<Listener>;
  /** Ring buffer of the most recent envelopes. Indexed by `seq`. */
  buffer: BroadcastEnvelope[];
  /** Next seq to assign. Monotonically increasing for the session's
   *  lifetime; resets only when the broadcaster is recreated. */
  nextSeq: number;
}

const RING_CAPACITY = 50;

/**
 * Workforce-wide listener type. Sees every broadcast for any session,
 * tagged with the sessionId. Powers `/api/home/stream` (Piece 5) — the
 * home view is interested in summary deltas across all sessions, not
 * any specific one, so a per-session subscribe would be wrong.
 */
export type WorkforceListener = (sessionId: string, env: BroadcastEnvelope) => void;

export class SessionBroadcaster {
  private sessions = new Map<string, SessionState>();
  private workforceListeners = new Set<WorkforceListener>();

  private stateFor(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { listeners: new Set(), buffer: [], nextSeq: 1 };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  broadcast(sessionId: string, event: SessionBroadcastEvent): void {
    const s = this.stateFor(sessionId);
    const env: BroadcastEnvelope = {
      seq: s.nextSeq++,
      ts: Date.now(),
      event,
    };
    s.buffer.push(env);
    if (s.buffer.length > RING_CAPACITY) {
      s.buffer.splice(0, s.buffer.length - RING_CAPACITY);
    }
    for (const fn of s.listeners) {
      try {
        fn(env);
      } catch (e) {
        log.warn({ err: e, sessionId }, "broadcaster listener threw");
      }
    }
    for (const fn of this.workforceListeners) {
      try {
        fn(sessionId, env);
      } catch (e) {
        log.warn({ err: e }, "workforce listener threw");
      }
    }
  }

  /**
   * Subscribe to events for one session. Returns a `replay` snapshot
   * of buffered events the caller can flush first (post-`Last-Event-ID`),
   * plus an unsubscribe handle. Pass `sinceSeq` to filter the replay;
   * omit for the full ring contents (typical first-connect).
   */
  subscribe(
    sessionId: string,
    listener: Listener,
    opts?: { sinceSeq?: number }
  ): { unsubscribe: () => void; replay: BroadcastEnvelope[] } {
    const s = this.stateFor(sessionId);
    s.listeners.add(listener);
    const replay =
      opts?.sinceSeq != null
        ? s.buffer.filter((e) => e.seq > opts.sinceSeq!)
        : s.buffer.slice();
    return {
      unsubscribe: () => {
        s.listeners.delete(listener);
        // Don't drop the session state — keep the buffer around for
        // future reconnects. Memory is bounded by RING_CAPACITY × N
        // sessions; cleanup happens explicitly on session delete.
      },
      replay,
    };
  }

  subscribeWorkforce(listener: WorkforceListener): () => void {
    this.workforceListeners.add(listener);
    return () => this.workforceListeners.delete(listener);
  }

  /** Clear all buffered state for a session — call on session delete. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
