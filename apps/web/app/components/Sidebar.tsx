"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  Bot,
  BookOpen,
  ListChecks,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/app/lib/utils";
import { API_BASE } from "@/app/lib/api";
import { navigateClient } from "@/app/lib/navigate";
import { Logotype } from "@/app/components/Logotype";
import { Logomark } from "@/app/components/Logomark";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { ActiveMarker } from "@/app/components/ui/active-marker";

// no width transition: the lab-instrument register prefers an instant snap
// over animating a layout property (DESIGN.md §6 "Don't animate layout").

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

// Order matters — Home first (default landing for the workforce
// operator), then composition pages (Agents, Tasks, Skills), then
// global config (Settings).
const navItems: NavItem[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/skills", label: "Skills", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

const COLLAPSED_KEY = "openacme-sidebar-collapsed";

// Use a layout effect on the client; on the server, fall back to
// useEffect so SSR/static prerender doesn't throw. The layout effect
// runs synchronously after render, before the browser paints — that
// lets us flip to the persisted value with no visible animate-in,
// while the initial render still matches the server's HTML (avoiding
// hydration mismatch warnings).
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function Sidebar({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname();
  const [version, setVersion] = useState<string | null>(null);
  // SSR + first client render both emit `collapsed=true` (same HTML, no
  // hydration warning). The layoutEffect flips it to the persisted value
  // before paint.
  const [collapsed, setCollapsed] = useState<boolean>(true);
  useIsomorphicLayoutEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLLAPSED_KEY);
      if (stored === "false") setCollapsed(false);
    } catch {
      // localStorage blocked — keep collapsed default.
    }
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, String(next));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data && typeof data.version === "string") setVersion(data.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col border-r border-paper-rule bg-sidebar text-sidebar-foreground",
        collapsed ? "w-14" : "w-60"
      )}
    >
      <div
        className={cn(
          "flex items-center border-b border-paper-rule py-5",
          collapsed ? "justify-center px-3" : "justify-between px-4"
        )}
      >
        {collapsed ? (
          <button
            onClick={toggle}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            className="group/logo relative flex size-7 items-center justify-center text-ink transition-colors hover:text-plot-red focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-plot-red"
          >
            <Logomark className="size-5 group-hover/logo:hidden" />
            <PanelLeftOpen className="hidden size-4 group-hover/logo:block" />
          </button>
        ) : (
          <>
            <Logotype className="h-6 w-auto text-ink" />
            <button
              onClick={toggle}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
              className="-mr-1 flex size-6 items-center justify-center text-ink-soft hover:bg-paper hover:text-ink focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-plot-red"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </>
        )}
      </div>

      <nav className="flex flex-col">
        {!collapsed && (
          <div className="px-4 pt-4 pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Console
          </div>
        )}
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          const Icon = item.icon;
          // Home → "/" is a same-route change ONLY when we're already
          // on the root route (e.g. clearing `?session=X` from the chat
          // page). In static-export mode Next's <Link> silently no-ops
          // that case, so we intercept and use `navigateClient`. But
          // when we're on a different route entirely (`/tasks`,
          // `/agents`, etc.) the Home link IS a real cross-route nav
          // and Next's <Link> handles it correctly — don't intercept,
          // or the page won't re-mount.
          const interceptHome = item.href === "/" && pathname === "/";
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              onClick={
                interceptHome
                  ? (e) => {
                      e.preventDefault();
                      navigateClient("/");
                    }
                  : undefined
              }
              className={cn(
                "group relative flex items-center gap-3 text-sm transition-colors",
                collapsed ? "justify-center py-2.5" : "px-4 py-2",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <ActiveMarker active={isActive} />
              <Icon className="size-4 shrink-0" />
              {!collapsed && <span className="font-medium">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {!collapsed && (
        <div className="flex-1 overflow-y-auto">{children}</div>
      )}
      {collapsed && <div className="flex-1" />}

      <div
        className={cn(
          "flex items-center border-t border-paper-rule",
          collapsed ? "justify-center px-2 py-3" : "justify-between gap-2 px-4 py-3"
        )}
      >
        {!collapsed && (
          <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            {version ? `v${version}` : "v—"}
          </div>
        )}
        <ThemeToggle compact={collapsed} />
      </div>
    </aside>
  );
}
