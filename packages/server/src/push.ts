import webpush from "web-push";
import type { PushStore, PushSubscriptionRow } from "@openacme/db";
import type { VapidKeys } from "./utils/vapid.js";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Notifications with the same tag replace each other on the lock
   *  screen — keeps a chatty agent from flooding. Default to "openacme". */
  tag?: string;
}

export interface PushDispatcherDeps {
  pushStore: PushStore;
  vapid: VapidKeys;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/** Web Push fan-out. Fetches every subscription, encrypts + sends in
 *  parallel, cleans up 404/410 endpoints. Survives a partial-failure
 *  storm (one bad endpoint doesn't break the others). */
export function createPushDispatcher(deps: PushDispatcherDeps) {
  const { pushStore, vapid, logger } = deps;
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  async function sendOne(sub: PushSubscriptionRow, body: string): Promise<void> {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        body,
        { TTL: 60 }
      );
      pushStore.touch(sub.id);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Endpoint gone — clean it up so we don't keep trying.
        pushStore.deleteByEndpoint(sub.endpoint);
        logger?.info(`push subscription ${sub.id} expired (${status}); removed`);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger?.warn(`push send failed for ${sub.id} (${status ?? "?"}): ${msg}`);
    }
  }

  return {
    /** Fan-out a notification to every subscribed device. Best-effort —
     *  resolves once every send settles (success or logged failure). */
    async dispatch(payload: PushPayload): Promise<void> {
      const subs = pushStore.list();
      if (subs.length === 0) return;
      // Cap title + body so we stay under the Safari ~2KB plaintext
      // budget without server-side guesswork. Full content gets fetched
      // on click-through via `url`.
      const safeTitle = truncate(payload.title, 80);
      const safeBody = truncate(payload.body, 200);
      const body = JSON.stringify({
        title: safeTitle,
        body: safeBody,
        url: payload.url,
        tag: payload.tag ?? "openacme",
      });
      await Promise.all(subs.map((sub) => sendOne(sub, body)));
    },
  };
}

export type PushDispatcher = ReturnType<typeof createPushDispatcher>;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
