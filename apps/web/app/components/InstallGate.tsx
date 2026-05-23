"use client";

import { useEffect, useState } from "react";
import { Share, Smartphone, Plus, Home } from "lucide-react";

type Platform = "ios-safari" | "android" | "desktop" | "unknown";

function detectPlatform(): Platform {
  if (typeof window === "undefined") return "unknown";
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !("MSStream" in window);
  if (isIOS) return "ios-safari";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

function isStandaloneNow(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  // iOS-only legacy flag. Type-cast so TS doesn't complain.
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Renders the right install prompt for the user's platform.
 *  - iOS Safari, not standalone: inline how-to with the Share icon.
 *  - Android (or any Chromium that fires `beforeinstallprompt`): an
 *    Install button that calls the stashed prompt.
 *  - Already running standalone: returns null — the parent's notification
 *    enable button is good to go.
 */
export function InstallGate() {
  const [platform, setPlatform] = useState<Platform>("unknown");
  const [standalone, setStandalone] = useState(false);
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    setPlatform(detectPlatform());
    setStandalone(isStandaloneNow());
    const onChange = () => setStandalone(isStandaloneNow());
    const mq = window.matchMedia("(display-mode: standalone)");
    mq.addEventListener("change", onChange);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => {
      mq.removeEventListener("change", onChange);
      window.removeEventListener("beforeinstallprompt", onPrompt);
    };
  }, []);

  if (standalone) {
    return (
      <div className="flex items-center gap-2 border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
        <span className="status-dot bg-signal-blue" aria-hidden />
        Running as installed app
      </div>
    );
  }

  if (platform === "ios-safari") {
    return (
      <div className="border border-paper-rule bg-paper-sunk p-4">
        <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
          <Smartphone className="size-3.5" aria-hidden />
          Install to home screen
        </div>
        <p className="mb-3 text-sm text-ink">
          iOS only supports notifications for installed web apps. Add OpenAcme
          to your home screen, then open it from there.
        </p>
        <ol className="space-y-2 text-sm text-ink-soft">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center border border-paper-rule font-mono text-[11px] text-ink">
              1
            </span>
            <span className="flex items-center gap-1.5">
              Tap the share button
              <Share
                className="size-4 text-signal-blue"
                aria-label="Share"
              />
              in the Safari toolbar.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center border border-paper-rule font-mono text-[11px] text-ink">
              2
            </span>
            <span className="flex items-center gap-1.5">
              Scroll down and tap
              <span className="inline-flex items-center gap-1 border border-paper-rule bg-paper px-1.5 py-0.5 font-mono text-[11px] text-ink">
                <Plus className="size-3" aria-hidden />
                Add to Home Screen
              </span>
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center border border-paper-rule font-mono text-[11px] text-ink">
              3
            </span>
            <span className="flex items-center gap-1.5">
              Open OpenAcme from the home screen icon
              <Home className="size-3.5" aria-hidden />
              and return to this page.
            </span>
          </li>
        </ol>
      </div>
    );
  }

  if (deferredPrompt) {
    return (
      <div className="flex items-center justify-between gap-3 border border-paper-rule bg-paper-sunk px-3 py-2">
        <div className="flex items-center gap-2">
          <Smartphone className="size-4 text-ink-soft" aria-hidden />
          <span className="text-sm text-ink">Install OpenAcme as an app</span>
        </div>
        <button
          type="button"
          onClick={async () => {
            await deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            if (outcome === "accepted") setDeferredPrompt(null);
          }}
          className="border border-paper-rule bg-paper px-3 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-ink hover:border-plot-red hover:text-plot-red"
        >
          Install
        </button>
      </div>
    );
  }

  // Desktop or Android without beforeinstallprompt yet — show nothing.
  // Notifications still work in regular browser tabs on those platforms.
  return null;
}

export function useIsStandalone(): boolean {
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    setStandalone(isStandaloneNow());
    const onChange = () => setStandalone(isStandaloneNow());
    const mq = window.matchMedia("(display-mode: standalone)");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return standalone;
}

export function useIsIos(): boolean {
  const [ios, setIos] = useState(false);
  useEffect(() => {
    setIos(detectPlatform() === "ios-safari");
  }, []);
  return ios;
}
