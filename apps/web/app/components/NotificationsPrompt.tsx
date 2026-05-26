"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Bell } from "lucide-react";
import { usePushSubscription } from "@/app/lib/push";

interface NavigatorStandalone extends Navigator {
  standalone?: boolean;
}

function isIOSSafariBrowserTab(): boolean {
  if (typeof window === "undefined") return false;
  // iOS Safari only delivers web push to installed PWAs. Detect iOS +
  // not-standalone, so we can suppress the prompt and surface the
  // install hint instead. Every other platform (Android Chrome, all
  // desktops including Safari 16.4+) supports push in a regular tab.
  const ua = window.navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  if (!isIOS) return false;
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as NavigatorStandalone).standalone === true;
  return !standalone;
}

const DISMISS_KEY = "openacme-notifications-prompt-dismissed";

/**
 * One-tap enable-notifications card. Browsers require a user gesture
 * for the OS permission dialog, so the absolute floor for first-time
 * enablement is one tap. After that, RegisterServiceWorker silently
 * re-subscribes on every launch — no Settings detour needed.
 *
 * Self-gates: shows whenever push is supported, permission is "default"
 * (never asked), and the user hasn't dismissed. Suppressed on iOS Safari
 * tabs (push only works there after PWA install — InstallHint covers
 * that path). Once granted or denied the card hides itself.
 */
export function NotificationsPrompt() {
  const push = usePushSubscription();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window) || !("PushManager" in window)) return;
    if (!("serviceWorker" in navigator)) return;
    // iOS Safari tab: push not supported here; the install hint will
    // guide the user to add-to-home-screen first.
    if (isIOSSafariBrowserTab()) return;
    if (Notification.permission !== "default") return;
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* ignore */
    }
    setShow(true);
  }, []);

  // Hide once permission is decided (granted or denied).
  useEffect(() => {
    if (push.permission === "granted" || push.permission === "denied") {
      setShow(false);
    }
  }, [push.permission]);

  if (!show) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setShow(false);
  };

  return (
    <div className="border-b border-paper-rule">
      <div className="flex items-start gap-3 px-4 py-3">
        <Bell className="mt-0.5 size-4 shrink-0 text-plot-red" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink">
            Enable notifications
          </div>
          <div className="mt-0.5 text-[12px] text-ink-soft">
            Get pinged when an agent needs you.
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            onClick={async () => {
              const r = await push.subscribe();
              if (r) toast.success("Notifications on");
            }}
            disabled={push.working}
            className="border border-ink bg-ink px-3 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-paper transition-colors hover:bg-plot-red hover:border-plot-red disabled:opacity-50"
          >
            Enable
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint hover:text-plot-red"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
