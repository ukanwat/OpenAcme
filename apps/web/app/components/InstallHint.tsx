"use client";

import { useEffect, useState } from "react";

const DISMISS_KEY = "openacme-ios-install-dismissed";

interface NavigatorStandalone extends Navigator {
  standalone?: boolean;
}

function detectIosSafari(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) && !("MSStream" in window);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  return (window.navigator as NavigatorStandalone).standalone === true;
}

/**
 * iOS install hint. Sidebar-bottom card that surfaces the manual
 * Share → Add to Home Screen flow (iOS has no programmatic install API).
 * Self-gates on iOS Safari + not standalone; auto-hides once the app is
 * launched from the home screen so no dismiss control is needed.
 */
export function InstallHint() {
  const [show, setShow] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!detectIosSafari()) return;
    if (isStandalone()) return;
    try {
      // Legacy dismiss flag — keep honouring so existing dismissals carry.
      // We removed the explicit Dismiss button at the user's request, but
      // anyone who already tapped it shouldn't have the hint reappear.
      if (window.localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      // storage blocked — show anyway
    }
    setShow(true);
  }, []);

  if (!show) return null;

  return (
    <div className="border-b border-paper-rule">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:text-plot-red"
        aria-expanded={expanded}
      >
        <span
          className="size-1.5 shrink-0 rounded-full bg-plot-red"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
          Install for notifications
        </span>
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
          {expanded ? "Hide" : "How"}
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 px-4 pb-3 text-[13px] leading-relaxed text-ink-soft">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-ink-faint">1.</span>
            <span>
              Tap <span className="text-ink">Share</span> in your browser
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-ink-faint">2.</span>
            <span>
              Pick <span className="text-ink">Add to Home Screen</span>
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-ink-faint">3.</span>
            <span>Open from home screen, enable in Settings</span>
          </div>
        </div>
      )}
    </div>
  );
}
