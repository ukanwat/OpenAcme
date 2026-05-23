import type { Hono } from "hono";
import type { AgentManager } from "../agent-manager.js";

/** Web Push subscription + test endpoints.
 *
 *  All routes inherit the existing `authMiddleware` — loopback bypasses,
 *  non-loopback requires the `openacme_session` cookie. No additional
 *  trust layer needed; subscribing without auth on a tunneled deployment
 *  would let strangers receive the operator's pings.
 */
export function registerPushRoutes(app: Hono, manager: AgentManager): void {
  app.get("/api/push/vapid-public-key", (c) => {
    const vapid = manager.vapid;
    if (!vapid) return c.json({ error: "Push not initialized" }, 503);
    return c.json({ publicKey: vapid.publicKey });
  });

  app.post("/api/push/subscribe", async (c) => {
    const pushStore = manager.pushStore;
    if (!pushStore) return c.json({ error: "Push not initialized" }, 503);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = parseSubscribeBody(body);
    if (!parsed) {
      return c.json(
        { error: "Body must be { subscription: { endpoint, keys: { p256dh, auth } }, userAgent? }" },
        400
      );
    }
    const row = pushStore.upsert({
      endpoint: parsed.endpoint,
      p256dh: parsed.p256dh,
      auth: parsed.auth,
      userAgent: parsed.userAgent,
    });
    return c.json({ id: row.id });
  });

  app.delete("/api/push/subscribe", async (c) => {
    const pushStore = manager.pushStore;
    if (!pushStore) return c.json({ error: "Push not initialized" }, 503);
    let body: { endpoint?: unknown } = {};
    try {
      body = (await c.req.json()) as { endpoint?: unknown };
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (typeof body.endpoint !== "string" || !body.endpoint) {
      return c.json({ error: "Body must be { endpoint: string }" }, 400);
    }
    pushStore.deleteByEndpoint(body.endpoint);
    return c.body(null, 204);
  });

  app.get("/api/push/subscriptions", (c) => {
    const pushStore = manager.pushStore;
    if (!pushStore) return c.json({ subscriptions: [] });
    return c.json({ subscriptions: pushStore.listPublic() });
  });

  app.delete("/api/push/subscriptions/:id", (c) => {
    const pushStore = manager.pushStore;
    if (!pushStore) return c.json({ error: "Push not initialized" }, 503);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "id required" }, 400);
    pushStore.deleteById(id);
    return c.body(null, 204);
  });

  app.post("/api/push/test", async (c) => {
    const dispatcher = manager.pushDispatcher;
    if (!dispatcher) return c.json({ error: "Push not initialized" }, 503);
    // Unique tag per test fire so each one alerts independently (same-tag
    // notifications replace the previous silently even with renotify on
    // some platforms).
    await dispatcher.dispatch({
      title: "OpenAcme test",
      body: "If you can read this, push notifications are working.",
      url: "/",
      tag: `openacme-test-${Date.now()}`,
    });
    return c.json({ ok: true });
  });
}

interface ParsedSubscribe {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

function parseSubscribeBody(body: unknown): ParsedSubscribe | null {
  if (!body || typeof body !== "object") return null;
  const top = body as { subscription?: unknown; userAgent?: unknown };
  const sub = top.subscription;
  if (!sub || typeof sub !== "object") return null;
  const s = sub as { endpoint?: unknown; keys?: unknown };
  if (typeof s.endpoint !== "string" || !s.endpoint) return null;
  if (!s.keys || typeof s.keys !== "object") return null;
  const keys = s.keys as { p256dh?: unknown; auth?: unknown };
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    return null;
  }
  return {
    endpoint: s.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userAgent: typeof top.userAgent === "string" ? top.userAgent : null,
  };
}
