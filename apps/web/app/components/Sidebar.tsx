"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  MessageSquare,
  Bot,
  BookOpen,
  ListChecks,
  Settings,
} from "lucide-react";
import { cn } from "@/app/lib/utils";
import { Logotype } from "@/app/components/Logotype";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/skills", label: "Skills", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-paper-rule bg-sidebar text-sidebar-foreground">
      <div className="border-b border-paper-rule px-4 py-4">
        <Logotype className="h-6 w-auto text-ink" />
        <div className="mt-3 flex items-center gap-1.5">
          <span className="status-dot pulse-live bg-plot-red" aria-hidden />
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft">
            Daemon · Live
          </span>
        </div>
      </div>

      <nav className="flex flex-col">
        <div className="px-4 pt-4 pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Console
        </div>
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group relative flex items-center gap-3 px-4 py-2 text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <span
                className={cn(
                  "absolute inset-y-0 left-0 w-[2px] bg-plot-red transition-opacity",
                  isActive ? "opacity-100" : "opacity-0"
                )}
                aria-hidden
              />
              <Icon className="size-3.5 shrink-0" />
              <span className="font-medium">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="flex-1 overflow-y-auto">{children}</div>

      <div className="border-t border-paper-rule px-4 py-3">
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          <span>OpenAcme</span>
          <span>v0.1.0</span>
        </div>
      </div>
    </aside>
  );
}
