import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { agentInbox, type AgentInboxRow } from "../schema.js";

import type { InboxKind, InboxSource } from "@openacme/tasks";

export type { AgentInboxRow } from "../schema.js";

export interface InboxDeliverInput {
  agentId: string;
  kind: InboxKind;
  source: InboxSource;
  sourceId?: string | null;
  relatedTask?: string | null;
  relatedSession?: string | null;
  /** Stored as JSON. For `user_message`, the full UIMessage shape. */
  payload: unknown;
}

/**
 * `InboxRow` is the read shape — `payload` is parsed JSON, not the raw
 * string. Consumers shouldn't deal with serialization at the store
 * boundary.
 */
export interface InboxRow {
  id: number;
  agentId: string;
  kind: InboxKind;
  source: InboxSource;
  sourceId: string | null;
  relatedTask: string | null;
  relatedSession: string | null;
  payload: unknown;
  createdAt: number;
}

function parseRow(row: AgentInboxRow): InboxRow {
  let payload: unknown = null;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      // Malformed JSON should never happen — we control all writers
      // and JSON.stringify never produces invalid JSON. Be defensive
      // anyway: rendering will treat null as "(no payload)" rather
      // than crashing the whole drain.
      payload = null;
    }
  }
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind as InboxKind,
    source: row.source as InboxSource,
    sourceId: row.sourceId ?? null,
    relatedTask: row.relatedTask ?? null,
    relatedSession: row.relatedSession ?? null,
    payload,
    createdAt: row.createdAt,
  };
}

/**
 * Per-agent delivery queue. Rows live until the runtime drains them
 * into a turn, then they're hard-deleted — the table is staging, not
 * audit. The audit trail is `task_events`.
 *
 * Echo suppression (don't deliver an agent's own actions back to it)
 * is the caller's responsibility — typically at AgentManager's
 * event-emit fan-out site.
 */
export function createInboxStore(db: Database.Database) {
  const orm = drizzle(db);

  return {
    deliver(input: InboxDeliverInput): number {
      const row = orm
        .insert(agentInbox)
        .values({
          agentId: input.agentId,
          kind: input.kind,
          source: input.source,
          sourceId: input.sourceId ?? null,
          relatedTask: input.relatedTask ?? null,
          relatedSession: input.relatedSession ?? null,
          payload: JSON.stringify(input.payload ?? null),
        })
        .returning({ id: agentInbox.id })
        .get();
      return row.id;
    },

    /** Oldest-first by id. Returns parsed rows. */
    pendingFor(agentId: string): InboxRow[] {
      const rows = orm
        .select()
        .from(agentInbox)
        .where(eq(agentInbox.agentId, agentId))
        .orderBy(asc(agentInbox.id))
        .all();
      return rows.map(parseRow);
    },

    /** Hard delete. Called after a successful drain. */
    deleteDelivered(ids: number[]): void {
      if (ids.length === 0) return;
      orm.delete(agentInbox).where(inArray(agentInbox.id, ids)).run();
    },

    /** Cleanup hook on agent removal. */
    deleteForAgent(agentId: string): void {
      orm.delete(agentInbox).where(eq(agentInbox.agentId, agentId)).run();
    },

    /** Cancel a queued user_message before its turn drains it. Match
     *  is by (agentId, sourceId, relatedSession) — sourceId carries
     *  the original user-message id from `/api/chat`. Returns the
     *  number of rows deleted (0 if already drained / never queued). */
    cancelQueuedUserMessage(input: {
      agentId: string;
      messageId: string;
      sessionId: string;
    }): number {
      const result = orm
        .delete(agentInbox)
        .where(
          and(
            eq(agentInbox.agentId, input.agentId),
            eq(agentInbox.kind, "user_message"),
            eq(agentInbox.sourceId, input.messageId),
            eq(agentInbox.relatedSession, input.sessionId)
          )
        )
        .run();
      return result.changes;
    },

    /** Counts (useful for the dispatcher's spawn rule and the web UI's
     *  pending-message indicator). Uses SQL `count(*)` so we don't
     *  load N rows just to take their length. */
    countFor(agentId: string): number {
      const row = orm
        .select({ count: count() })
        .from(agentInbox)
        .where(eq(agentInbox.agentId, agentId))
        .get();
      return row?.count ?? 0;
    },

    /** Bulk count across agents — for dispatcher tick efficiency.
     *  Single GROUP BY query rather than one query per agent. */
    countsByAgent(agentIds: string[]): Map<string, number> {
      if (agentIds.length === 0) return new Map();
      const rows = orm
        .select({
          agentId: agentInbox.agentId,
          count: count(),
        })
        .from(agentInbox)
        .where(inArray(agentInbox.agentId, agentIds))
        .groupBy(agentInbox.agentId)
        .all();
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.agentId, r.count);
      return counts;
    },
  };
}

export type InboxStore = ReturnType<typeof createInboxStore>;
