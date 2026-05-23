"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "@/app/lib/api";

export type PushPermission = NotificationPermission | "unsupported";

export interface PushDevice {
  id: string;
  userAgent: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

interface SubscribeResult {
  endpoint: string;
  id: string;
}

/** Convert the base64url-encoded VAPID public key to the Uint8Array the
 *  PushManager.subscribe API requires. Some browsers accept base64url
 *  strings directly; others reject — this helper is the cross-browser
 *  baseline. */
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

function supportsPush(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function usePushSubscription() {
  const [supported, setSupported] = useState<boolean>(false);
  const [permission, setPermission] = useState<PushPermission>("default");
  const [subscribed, setSubscribed] = useState<boolean>(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [working, setWorking] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Probe current state — supported? permission? already subscribed?
  const refresh = useCallback(async () => {
    if (!supportsPush()) {
      setSupported(false);
      setPermission("unsupported");
      return;
    }
    setSupported(true);
    setPermission(Notification.permission);
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      setSubscribed(!!existing);
      setEndpoint(existing?.endpoint ?? null);
    } catch {
      setSubscribed(false);
      setEndpoint(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const subscribe = useCallback(async (): Promise<SubscribeResult | null> => {
    if (!supportsPush()) {
      setError("This browser does not support push notifications.");
      return null;
    }
    setWorking(true);
    setError(null);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        setError(
          perm === "denied"
            ? "Notifications are blocked. Enable them in your browser settings."
            : "Permission was not granted."
        );
        return null;
      }
      const reg = await navigator.serviceWorker.ready;
      const keyRes = await fetch(`${API_BASE}/api/push/vapid-public-key`);
      if (!keyRes.ok) throw new Error(`vapid key fetch ${keyRes.status}`);
      const { publicKey } = (await keyRes.json()) as { publicKey: string };
      // Reuse any existing subscription so we don't generate a fresh
      // endpoint per click.
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBuffer(publicKey),
        }));
      const json = sub.toJSON() as {
        endpoint?: string;
        keys?: { p256dh?: string; auth?: string };
      };
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("Subscription is missing endpoint or keys.");
      }
      const res = await fetch(`${API_BASE}/api/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: json,
          userAgent:
            typeof navigator !== "undefined" ? navigator.userAgent : null,
        }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`subscribe failed: ${res.status} ${msg}`);
      }
      const { id } = (await res.json()) as { id: string };
      setSubscribed(true);
      setEndpoint(json.endpoint);
      return { endpoint: json.endpoint, id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    } finally {
      setWorking(false);
    }
  }, []);

  const unsubscribe = useCallback(async (): Promise<boolean> => {
    if (!supportsPush()) return false;
    setWorking(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (!existing) {
        setSubscribed(false);
        setEndpoint(null);
        return true;
      }
      const ep = existing.endpoint;
      await existing.unsubscribe();
      await fetch(`${API_BASE}/api/push/subscribe`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: ep }),
      });
      setSubscribed(false);
      setEndpoint(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setWorking(false);
    }
  }, []);

  return {
    supported,
    permission,
    subscribed,
    endpoint,
    working,
    error,
    refresh,
    subscribe,
    unsubscribe,
  };
}

export async function fetchDevices(): Promise<PushDevice[]> {
  const res = await fetch(`${API_BASE}/api/push/subscriptions`);
  if (!res.ok) throw new Error(`devices fetch ${res.status}`);
  const data = (await res.json()) as { subscriptions: PushDevice[] };
  return data.subscriptions;
}

export async function deleteDevice(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/push/subscriptions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`device delete ${res.status}`);
}
