import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { pushSubscriptions, type PushSubscriptionRow } from "../schema.js";

export type { PushSubscriptionRow } from "../schema.js";

export interface PushSubscriptionPublic {
  id: string;
  userAgent: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface PushUpsertInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

function publicShape(row: PushSubscriptionRow): PushSubscriptionPublic {
  return {
    id: row.id,
    userAgent: row.userAgent ?? null,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? null,
  };
}

/**
 * Web Push subscription store. Single-operator deployment — no user_id,
 * no per-recipient routing. Endpoint uniqueness means re-subscribe is
 * idempotent: same endpoint → row updated in place with refreshed keys.
 *
 * Key material is internal: `list()` returns full rows for the
 * dispatcher; `listPublic()` returns the safe shape for API responses.
 */
export function createPushStore(db: Database.Database) {
  const orm = drizzle(db);

  return {
    upsert(input: PushUpsertInput): PushSubscriptionRow {
      const existing = orm
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, input.endpoint))
        .get();
      if (existing) {
        orm
          .update(pushSubscriptions)
          .set({
            p256dh: input.p256dh,
            auth: input.auth,
            userAgent: input.userAgent ?? existing.userAgent ?? null,
          })
          .where(eq(pushSubscriptions.endpoint, input.endpoint))
          .run();
        return {
          ...existing,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent ?? existing.userAgent ?? null,
        };
      }
      const id = randomUUID();
      const row = orm
        .insert(pushSubscriptions)
        .values({
          id,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent ?? null,
        })
        .returning()
        .get();
      return row;
    },

    list(): PushSubscriptionRow[] {
      return orm.select().from(pushSubscriptions).all();
    },

    listPublic(): PushSubscriptionPublic[] {
      return this.list().map(publicShape);
    },

    getById(id: string): PushSubscriptionRow | null {
      const row = orm
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.id, id))
        .get();
      return row ?? null;
    },

    deleteById(id: string): void {
      orm.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run();
    },

    deleteByEndpoint(endpoint: string): void {
      orm
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint))
        .run();
    },

    touch(id: string): void {
      orm
        .update(pushSubscriptions)
        .set({ lastUsedAt: sql`(unixepoch())` })
        .where(eq(pushSubscriptions.id, id))
        .run();
    },
  };
}

export type PushStore = ReturnType<typeof createPushStore>;
