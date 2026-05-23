"use client";

import { useEffect } from "react";
import { API_BASE } from "@/app/lib/api";

function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

/**
 * Best-effort re-subscribe in the background when permission is already
 * granted. iOS standalone PWAs silently evict push subscriptions between
 * launches; without this, the user has to manually re-enable in Settings
 * after every OS-level eviction. Idempotent server-side (endpoint is
 * UNIQUE so a re-subscribe just upserts the row).
 */
async function autoResubscribe(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("Notification" in window) || !("PushManager" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      // Push the (possibly fresh-from-eviction) subscription back to the
      // server. Server's UNIQUE(endpoint) makes this idempotent.
      const json = existing.toJSON() as {
        endpoint?: string;
        keys?: { p256dh?: string; auth?: string };
      };
      if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
        await fetch(`${API_BASE}/api/push/subscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subscription: json,
            userAgent: navigator.userAgent,
          }),
        }).catch(() => undefined);
      }
      return;
    }
    // No subscription — fetch the VAPID public key and create one.
    // pushManager.subscribe with userVisibleOnly does NOT require a
    // user gesture once permission is already granted, so this can run
    // silently on launch.
    const keyRes = await fetch(`${API_BASE}/api/push/vapid-public-key`);
    if (!keyRes.ok) return;
    const { publicKey } = (await keyRes.json()) as { publicKey?: string };
    if (!publicKey) return;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBuffer(publicKey),
    });
    const json = sub.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
    await fetch(`${API_BASE}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: json,
        userAgent: navigator.userAgent,
      }),
    }).catch(() => undefined);
  } catch {
    // Silent — auto-resubscribe is opportunistic; failure leaves the
    // Settings page as the manual fallback path.
  }
}

// Idempotent SW registration. Mounted once in the root layout so every
// page boot ensures /sw.js is registered and current — `register()` is
// a no-op when the same script is already controlling the page.
export function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Skip on http:// non-loopback — browsers refuse SW registration
    // outside secure contexts. Loopback is treated as secure.
    const isSecure =
      window.isSecureContext ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    if (!isSecure) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(() => {
        // Once registered, opportunistically re-subscribe when permission
        // is already granted. Doesn't show any UI; doesn't request
        // permission (that still requires a user gesture in Settings).
        void autoResubscribe();
      })
      .catch(() => {
        // SW registration failure is non-fatal — the app still works
        // without push notifications. Swallow rather than spam errors.
      });
  }, []);
  return null;
}
