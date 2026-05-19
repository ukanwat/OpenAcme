"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { API_BASE } from "@/app/lib/api";
import { cn } from "@/app/lib/utils";
import {
  Bot,
  Home,
  ListChecks,
  BookOpen,
  Settings,
  Plus,
  HelpCircle,
} from "lucide-react";

interface AgentLite {
  id: string;
  name: string;
  role?: string;
}

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  icon?: React.ComponentType<{ className?: string }>;
  onSelect: () => void;
}

interface PaletteSection {
  label: string;
  items: PaletteItem[];
}

// Substring filter with a tiny score: prefix matches rank above mid-string,
// length-of-match weights ties. Keep it dumb on purpose — the operator is
// typing exact substrings of names they remember, not fuzzy fragments.
function score(query: string, label: string, hint?: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  const h = (hint ?? "").toLowerCase();
  const li = l.indexOf(q);
  const hi = h.indexOf(q);
  if (li === -1 && hi === -1) return 0;
  if (li === 0) return 1000 - l.length;
  if (li > 0) return 500 - li;
  return 100 - hi;
}

export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [agents, setAgents] = useState<AgentLite[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Cmd-K / Ctrl-K toggle. Bare `k` would clash with text inputs; require
  // the modifier so it works no matter where focus is.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Reset transient state on open; lazy-fetch agents the first time the
  // palette opens (no need to pay for the round-trip on cold load).
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    if (agents === null) {
      const ctrl = new AbortController();
      fetch(`${API_BASE}/api/agents`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : []))
        .then((list: AgentLite[]) => setAgents(list))
        .catch(() => setAgents([]));
      return () => ctrl.abort();
    }
  }, [open, agents]);

  // Closing also clears the input so a re-open doesn't carry stale text.
  function close() {
    setOpen(false);
    setQuery("");
  }

  const sections = useMemo<PaletteSection[]>(() => {
    const agentItems: PaletteItem[] = (agents ?? []).map((a) => ({
      id: `agent-${a.id}`,
      label: a.name,
      hint: a.id,
      icon: Bot,
      onSelect: () => {
        router.push(`/agents?id=${encodeURIComponent(a.id)}`);
        close();
      },
    }));

    const chatItems: PaletteItem[] = (agents ?? []).map((a) => ({
      id: `chat-${a.id}`,
      label: `Chat with ${a.name}`,
      hint: a.id,
      icon: Bot,
      onSelect: () => {
        router.push(`/?agent=${encodeURIComponent(a.id)}`);
        close();
      },
    }));

    const actionItems: PaletteItem[] = [
      {
        id: "go-home",
        label: "Go to Home",
        icon: Home,
        onSelect: () => {
          router.push("/");
          close();
        },
      },
      {
        id: "go-agents",
        label: "Go to Agents",
        icon: Bot,
        onSelect: () => {
          router.push("/agents");
          close();
        },
      },
      {
        id: "go-tasks",
        label: "Go to Tasks",
        icon: ListChecks,
        onSelect: () => {
          router.push("/tasks");
          close();
        },
      },
      {
        id: "go-skills",
        label: "Go to Skills",
        icon: BookOpen,
        onSelect: () => {
          router.push("/skills");
          close();
        },
      },
      {
        id: "go-settings",
        label: "Go to Settings",
        icon: Settings,
        onSelect: () => {
          router.push("/settings");
          close();
        },
      },
      {
        id: "new-agent",
        label: "New agent",
        icon: Plus,
        onSelect: () => {
          router.push("/agents?new=1");
          close();
        },
      },
      {
        id: "help",
        label: "Open help",
        shortcut: "?",
        icon: HelpCircle,
        onSelect: () => {
          close();
          // Dispatch after the palette closes so Radix doesn't trap focus
          // back to the palette when the help overlay mounts.
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent("openacme:open-help"));
          }, 0);
        },
      },
    ];

    // Filter + score each section; sort by descending score, drop zeros.
    const filtered = (raw: PaletteItem[]): PaletteItem[] =>
      raw
        .map((it) => ({ it, s: score(query, it.label, it.hint) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.it);

    const out: PaletteSection[] = [];
    const filteredAgents = filtered(agentItems);
    if (filteredAgents.length > 0)
      out.push({ label: "Agents", items: filteredAgents });
    const filteredChats = filtered(chatItems);
    if (filteredChats.length > 0)
      out.push({ label: "Sessions", items: filteredChats });
    const filteredActions = filtered(actionItems);
    if (filteredActions.length > 0)
      out.push({ label: "Actions", items: filteredActions });
    return out;
  }, [agents, query, router]);

  // Flatten for keyboard nav. Section labels don't count as targets.
  const flat = useMemo(
    () => sections.flatMap((s) => s.items),
    [sections]
  );

  // Clamp active index whenever the filtered list shrinks/grows.
  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1));
  }, [flat.length, active]);

  // Hide actions that just navigate to the current page so the palette
  // doesn't waste a row on "Go to /tasks" when you're already there.
  const visibleSections = useMemo(() => {
    return sections
      .map((s) => ({
        ...s,
        items: s.items.filter((it) => {
          if (it.id === "go-home") return pathname !== "/";
          if (it.id === "go-agents") return pathname !== "/agents";
          if (it.id === "go-tasks") return pathname !== "/tasks";
          if (it.id === "go-skills") return pathname !== "/skills";
          if (it.id === "go-settings") return pathname !== "/settings";
          return true;
        }),
      }))
      .filter((s) => s.items.length > 0);
  }, [sections, pathname]);

  const visibleFlat = useMemo(
    () => visibleSections.flatMap((s) => s.items),
    [visibleSections]
  );

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(visibleFlat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      visibleFlat[active]?.onSelect();
    }
  }

  // Scroll the active row into view on arrow-key nav.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-palette-index="${active}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let runningIndex = 0;

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
      <DialogContent
        showCloseButton={false}
        className="top-[20%] max-w-xl translate-y-0 bg-paper-sunk p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="border-b border-paper-rule px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            placeholder="Type a command, an agent name, or a page…"
            className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-faint"
            aria-label="Command palette"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div
          ref={listRef}
          className="max-h-[60vh] overflow-y-auto py-1"
          role="listbox"
        >
          {visibleFlat.length === 0 && (
            <div className="px-4 py-8 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              No matches
            </div>
          )}

          {visibleSections.map((section) => (
            <div key={section.label} className="py-1">
              <div className="px-4 pb-1 pt-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                {section.label}
              </div>
              {section.items.map((item) => {
                const idx = runningIndex++;
                const isActive = idx === active;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-palette-index={idx}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => item.onSelect()}
                    className={cn(
                      "relative flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors",
                      isActive
                        ? "bg-paper text-ink"
                        : "text-ink-soft hover:bg-paper hover:text-ink"
                    )}
                  >
                    {isActive && (
                      <span
                        aria-hidden
                        className="absolute inset-y-0 left-0 w-[2px] bg-plot-red"
                      />
                    )}
                    {Icon && <Icon className="size-4 shrink-0 text-ink-soft" />}
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.hint && (
                      <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                        {item.hint}
                      </span>
                    )}
                    {item.shortcut && (
                      <span className="font-mono text-[11px] text-ink-faint">
                        {item.shortcut}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-paper-rule px-4 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          <span>
            <span className="text-ink-soft">↑↓</span> navigate ·{" "}
            <span className="text-ink-soft">⏎</span> open ·{" "}
            <span className="text-ink-soft">esc</span> close
          </span>
          <span>⌘K</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
