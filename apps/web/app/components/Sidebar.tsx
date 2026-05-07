"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare, Bot, BookOpen, Settings, Zap } from "lucide-react";
import { cn } from "@/app/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/skills", label: "Skills", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Zap className="size-4" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold leading-none">OpenAcme</span>
          <span className="text-[10px] text-muted-foreground">Agent Platform</span>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 p-2">
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
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="flex-1 overflow-y-auto">{children}</div>

      <div className="border-t px-4 py-3 text-[11px] text-muted-foreground">
        v0.1.0 · OpenAcme
      </div>
    </aside>
  );
}
