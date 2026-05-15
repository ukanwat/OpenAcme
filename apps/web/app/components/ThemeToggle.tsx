"use client";

import { useEffect, useState } from "react";
import { Moon, Sun, Monitor } from "lucide-react";
import { cn } from "@/app/lib/utils";

type Choice = "system" | "light" | "dark";

const KEY = "openacme.theme";

/*
 * Apply the visual class on <html>, given the user's choice.
 * "system" follows prefers-color-scheme. "light" / "dark" force.
 * Kept in sync with the inline script in layout.tsx so SSR matches.
 */
function applyTheme(choice: Choice) {
  const sys = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = choice === "dark" || (choice === "system" && sys);
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeToggle({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const [choice, setChoice] = useState<Choice>("system");
  // Avoid hydration mismatch — render placeholder until mounted, then read.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = window.localStorage.getItem(KEY) as Choice | null;
    if (stored === "light" || stored === "dark" || stored === "system") {
      setChoice(stored);
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    if (choice === "system") {
      window.localStorage.removeItem(KEY);
    } else {
      window.localStorage.setItem(KEY, choice);
    }
    applyTheme(choice);
  }, [choice, mounted]);

  // Re-apply when system preference changes and user is on "system".
  useEffect(() => {
    if (!mounted) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (choice === "system") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice, mounted]);

  const options = [
    { value: "system", icon: Monitor, label: "System" },
    { value: "light", icon: Sun, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
  ] as const satisfies readonly { value: Choice; icon: typeof Sun; label: string }[];

  if (compact) {
    const idx = options.findIndex((o) => o.value === choice);
    const current = options[idx === -1 ? 0 : idx]!;
    const Icon = current.icon;
    const next = options[(idx + 1) % options.length]!;
    return (
      <button
        type="button"
        aria-label={`Theme: ${current.label}. Click for ${next.label}.`}
        title={`Theme: ${current.label}`}
        onClick={() => setChoice(next.value)}
        className={cn(
          "flex size-6 items-center justify-center border border-paper-rule bg-paper text-ink-soft transition-colors hover:bg-paper-sunk hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-plot-red",
          className
        )}
      >
        <Icon className="size-3" />
      </button>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        "inline-flex border border-paper-rule",
        className
      )}
    >
      {options.map(({ value, icon: Icon, label }) => {
        const active = mounted && choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setChoice(value)}
            className={cn(
              "flex size-6 items-center justify-center transition-colors not-first:border-l not-first:border-paper-rule focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-plot-red",
              active
                ? "bg-ink text-paper"
                : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink"
            )}
          >
            <Icon className="size-3" />
          </button>
        );
      })}
    </div>
  );
}
