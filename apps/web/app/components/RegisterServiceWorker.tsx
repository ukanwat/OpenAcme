"use client";

import { useEffect } from "react";

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
      .catch(() => {
        // SW registration failure is non-fatal — the app still works
        // without push notifications. Swallow rather than spam errors.
      });
  }, []);
  return null;
}
