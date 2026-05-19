"use client";

/**
 * Home — the operator's primary surface. Three sections: Waiting,
 * Running, Idle. Sessions whose tasks are all terminal don't appear.
 * Live updates via `useHomeStream` (SSE).
 *
 * Click a row → navigate to `/?session=<id>`. The chat panel in
 * `page.tsx` picks that up and renders the conversation.
 *
 * `compact` mode = the rail variant rendered alongside an open chat
 * panel. Same data, narrower layout, no right-hand activity column,
 * the active session is highlighted so the rail doubles as a
 * persistent session switcher.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bell,
  CircleDot,
  Pause,
  Bot,
  Clock,
  MessageSquarePlus,
  Plus,
  ChevronDown,
  Filter as FilterIcon,
  Trash2,
} from "lucide-react";
import { useHomeStream } from "@/app/lib/useHomeStream";
import { API_BASE } from "@/app/lib/api";
import type { SessionSummary } from "@/app/lib/types";
import { cn } from "@/app/lib/utils";
import { navigateClient } from "@/app/lib/navigate";
import { Button } from "@/app/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";

/** Subset of AgentDefinition surfaced on the fresh-install picker.
 *  Mirrors what `/api/agents` returns; kept narrow so this component
 *  doesn't pull in the chat page's local Agent type. */
interface AgentPickerEntry {
  id: string;
  name: string;
  role: string;
}

function formatRelative(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - unixSeconds);
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatDefer(unixSeconds: number | null): string | null {
  if (unixSeconds == null) return null;
  const now = Math.floor(Date.now() / 1000);
  const diff = unixSeconds - now;
  if (diff <= 0) return null;
  if (diff < 60) return `quiet ${diff}s`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `quiet ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `quiet ${h}h`;
  const d = Math.floor(h / 24);
  return `quiet ${d}d`;
}

interface RowProps {
  s: SessionSummary;
  onClick: () => void;
  onDelete: () => void;
  compact: boolean;
  active: boolean;
}

/** Common keyboard handler for div-as-button: Enter and Space activate. */
function activateOnKey(handler: () => void) {
  return (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  };
}

function SessionRow({ s, onClick, onDelete, compact, active }: RowProps) {
  const wakeLabel = formatDefer(s.deferUntil);
  const statusDot =
    s.status === "waiting"
      ? "bg-plot-red pulse-live"
      : s.status === "running"
        ? "bg-amber-500 pulse-live"
        : "bg-ink-faint";
  const statusLabel =
    s.status === "waiting"
      ? "Waiting"
      : s.status === "running"
        ? "Running"
        : "Idle";
  const statusTextColor =
    s.status === "waiting"
      ? "text-plot-red"
      : s.status === "running"
        ? "text-amber-600 dark:text-amber-400"
        : "text-ink-soft";

  const deleteButton = (size: "compact" | "full") => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      aria-label="Delete session"
      title="Delete session"
      className={cn(
        "shrink-0 rounded p-1 text-ink-faint opacity-0 transition-opacity hover:bg-paper-rule/60 hover:text-plot-red focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-plot-red group-hover:opacity-100",
        size === "compact" ? "size-6" : "size-7"
      )}
    >
      <Trash2 className={size === "compact" ? "size-3" : "size-3.5"} aria-hidden />
    </button>
  );

  if (compact) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={activateOnKey(onClick)}
        className={cn(
          "group relative flex w-full items-start gap-2 border-b border-paper-rule px-3 py-2 text-left transition-colors cursor-pointer",
          active
            ? "bg-paper text-ink"
            : "hover:bg-sidebar-accent/40"
        )}
      >
        {active && (
          <span
            className="absolute inset-y-0 left-0 w-[3px] bg-plot-red"
            aria-hidden
          />
        )}
        <span
          className={cn("status-dot mt-1.5", statusDot)}
          aria-hidden
          title={statusLabel}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">
            {s.title || "Untitled session"}
          </div>
          <div className="flex items-center gap-1 truncate text-[11px] text-ink-soft">
            <Bot className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{s.agentName}</span>
            <span className="text-ink-faint">·</span>
            <span className="truncate font-mono tabular-nums">
              {formatRelative(s.lastActivity)}
            </span>
          </div>
          {s.pingMessage && (
            <div className="mt-1 line-clamp-2 rounded border border-plot-red/30 bg-plot-red/5 px-1.5 py-0.5 text-[11px] text-ink">
              <Bell
                className="mr-1 inline size-2.5 -translate-y-px text-plot-red"
                aria-hidden
              />
              {s.pingMessage}
            </div>
          )}
        </div>
        {deleteButton("compact")}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={activateOnKey(onClick)}
      className={cn(
        "group flex w-full items-start gap-4 border-b border-paper-rule px-6 py-3 text-left transition-colors cursor-pointer",
        "hover:bg-sidebar-accent/40"
      )}
    >
      <div className="flex w-32 shrink-0 items-center gap-2 pt-0.5">
        <span className={cn("status-dot", statusDot)} aria-hidden />
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.08em]",
            statusTextColor
          )}
        >
          {statusLabel}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <Bot className="size-3.5 shrink-0 text-ink-soft" aria-hidden />
          <Link
            href={`/agents?id=${encodeURIComponent(s.agentId)}`}
            onClick={(e) => e.stopPropagation()}
            className="font-medium hover:underline"
          >
            {s.agentName}
          </Link>
          <span className="text-ink-faint">·</span>
          <span className="min-w-0 truncate text-ink">
            {s.title || "Untitled session"}
          </span>
        </div>
        {s.currentTaskTitle && (
          <div className="mt-1 truncate text-[12px] text-ink-soft">
            on: {s.currentTaskTitle}
          </div>
        )}
        {s.pingMessage && (
          <div className="mt-1 line-clamp-2 rounded border border-plot-red/30 bg-plot-red/5 px-2 py-1 text-[12px] text-ink">
            <Bell className="mr-1 inline size-3 -translate-y-px text-plot-red" aria-hidden />
            {s.pingMessage}
          </div>
        )}
      </div>
      <div className="flex w-40 shrink-0 flex-col items-end gap-1 pt-1 text-right">
        <span className="font-mono text-[11px] tabular-nums text-ink-faint">
          {formatRelative(s.lastActivity)}
        </span>
        {wakeLabel && (
          <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft">
            <Clock className="size-3" aria-hidden />
            {wakeLabel}
          </span>
        )}
        {s.pendingTaskCount > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft">
            {s.pendingTaskCount} task{s.pendingTaskCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {deleteButton("full")}
    </div>
  );
}

function Section({
  title,
  hint,
  icon: Icon,
  tone,
  sessions,
  onPick,
  onDelete,
  compact,
  activeSessionId,
}: {
  title: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "waiting" | "running" | "idle";
  sessions: SessionSummary[];
  onPick: (sid: string) => void;
  onDelete: (sid: string) => void;
  compact: boolean;
  activeSessionId: string | null;
}) {
  if (sessions.length === 0) return null;
  const toneColor =
    tone === "waiting"
      ? "text-plot-red"
      : tone === "running"
        ? "text-amber-600 dark:text-amber-400"
        : "text-ink-soft";
  return (
    <section className={compact ? "mt-3" : "mt-6"}>
      <div
        className={cn(
          "flex items-center justify-between pb-2",
          compact ? "px-3" : "px-6"
        )}
      >
        <h2
          className={cn(
            "flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.10em]",
            toneColor
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {title}
          <span className="font-mono text-ink-faint">·</span>
          <span className="font-mono text-ink-faint">{sessions.length}</span>
        </h2>
        {hint && !compact && (
          <span className="font-mono text-[10px] text-ink-faint">{hint}</span>
        )}
      </div>
      <div className="border-t border-paper-rule">
        {sessions.map((s) => (
          <SessionRow
            key={s.sessionId}
            s={s}
            onClick={() => onPick(s.sessionId)}
            onDelete={() => onDelete(s.sessionId)}
            compact={compact}
            active={activeSessionId === s.sessionId}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Always-on "+ New chat" entry point. Opens a popover with the same
 * agent grid the EmptyState uses. Picking an agent navigates to
 * `/?agent=<id>` (no session id) — the chat page already supports
 * this state via ChatAgentReadyState until the first message commits
 * a session via `/api/chat`.
 *
 * Self-fetches `/api/agents` so the parent doesn't have to thread it.
 * Renders nothing until the first agent loads (avoids a flash of a
 * disabled-looking button).
 */
function NewChatPopover({ compact }: { compact: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentPickerEntry[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/agents`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((list: AgentPickerEntry[]) => setAgents(list))
      .catch(() => {
        if (!ctrl.signal.aborted) setAgents([]);
      });
    return () => ctrl.abort();
  }, []);

  // Hide the trigger until we know there's at least one agent — there
  // is nothing to start a chat with otherwise, and the link from
  // EmptyState's "Create an agent" CTA already handles the recovery path.
  if (!agents || agents.length === 0) return null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? agents.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.role?.toLowerCase().includes(q)
      )
    : agents;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        {compact ? (
          <button
            type="button"
            aria-label="New chat"
            className="flex size-7 shrink-0 items-center justify-center border border-paper-rule bg-paper text-ink-soft transition-colors hover:border-plot-red hover:text-plot-red"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1.5 border border-paper-rule bg-paper px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:border-plot-red hover:text-plot-red"
          >
            <Plus className="size-3.5" aria-hidden />
            New chat
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="flex w-72 flex-col p-0"
      >
        <div className="border-b border-paper-rule px-3 py-2">
          <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
            Start a chat
          </p>
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
            className="w-full border border-paper-rule bg-paper px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-plot-red"
          />
        </div>
        <ul className="max-h-[50vh] overflow-y-auto">
          {filtered.length === 0 ? (
            <li className="px-3 py-3 text-center text-[12px] text-ink-faint">
              No agents match.
            </li>
          ) : (
            filtered.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setQuery("");
                    // Preserve other params (e.g. ?agentFilter) so
                    // picking a new chat doesn't drop the operator's
                    // filter. Drop ?session — this is a fresh chat.
                    const params = new URLSearchParams(
                      searchParams.toString()
                    );
                    params.set("agent", a.id);
                    params.delete("session");
                    navigateClient(`/?${params.toString()}`);
                  }}
                  className="group flex w-full items-start gap-3 border-b border-paper-rule px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-paper-sunk"
                >
                  <MessageSquarePlus
                    className="mt-0.5 size-4 shrink-0 text-ink-soft group-hover:text-plot-red"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">
                      {a.name}
                    </div>
                    {a.role && (
                      <div className="mt-0.5 line-clamp-2 text-[12px] text-ink-soft">
                        {a.role}
                      </div>
                    )}
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Single-button dropdown that scopes the home view to one agent.
 * Replaces the prior chip-per-agent row — that visual got noisy at 5+
 * agents. The popover content mirrors NewChatPopover (search + list)
 * so both pickers feel the same.
 */
function FilterByAgentPopover({
  agentTotals,
  active,
  onPick,
  compact,
}: {
  agentTotals: { id: string; name: string; count: number }[];
  active: string | null;
  onPick: (id: string | null) => void;
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const total = agentTotals.reduce((sum, t) => sum + t.count, 0);
  const activeName = agentTotals.find((t) => t.id === active)?.name ?? null;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? agentTotals.filter((t) => t.name.toLowerCase().includes(q))
    : agentTotals;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center gap-1.5 border bg-paper text-[12px] transition-colors hover:border-plot-red/60",
            compact ? "px-2 py-1" : "px-2.5 py-1",
            active
              ? "border-plot-red/60 text-plot-red"
              : "border-paper-rule text-ink"
          )}
          aria-label="Filter by agent"
        >
          <FilterIcon className="size-3.5" aria-hidden />
          <span className="font-medium">
            {activeName ?? "All agents"}
          </span>
          <span className="font-mono tabular-nums text-ink-faint">
            ·&nbsp;{active ? agentTotals.find((t) => t.id === active)?.count ?? 0 : total}
          </span>
          <ChevronDown className="size-3.5 text-ink-soft" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="flex w-64 flex-col p-0"
      >
        <div className="border-b border-paper-rule px-3 py-2">
          <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
            Filter by agent
          </p>
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
            className="w-full border border-paper-rule bg-paper px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-plot-red"
          />
        </div>
        <ul className="max-h-[50vh] overflow-y-auto">
          <li>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setQuery("");
                onPick(null);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-3 border-b border-paper-rule px-3 py-2 text-left text-[13px] transition-colors hover:bg-paper-sunk",
                !active && "bg-plot-red/10 text-plot-red"
              )}
            >
              <span className="font-medium">All agents</span>
              <span className="font-mono tabular-nums text-ink-faint">
                {total}
              </span>
            </button>
          </li>
          {filtered.length === 0 ? (
            <li className="px-3 py-3 text-center text-[12px] text-ink-faint">
              No agents match.
            </li>
          ) : (
            filtered.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setQuery("");
                    onPick(a.id);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 border-b border-paper-rule px-3 py-2 text-left text-[13px] transition-colors last:border-b-0 hover:bg-paper-sunk",
                    active === a.id && "bg-plot-red/10 text-plot-red"
                  )}
                >
                  <span className="truncate font-medium">{a.name}</span>
                  <span className="font-mono tabular-nums text-ink-faint">
                    {a.count}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Empty state — no active sessions in any bucket. Two paths:
 *
 *   - Workforce has at least one agent (the normal case post-Acme
 *     auto-materialization): show a picker so the user can start a
 *     fresh chat. Without this, a clean install lands on Home with
 *     "Nothing's running" and no way to reach the chat UI.
 *   - Zero agents (the user deleted everything, including Acme): point
 *     them at the Agents page to recreate one.
 */
function EmptyState({ compact }: { compact: boolean }) {
  const [agents, setAgents] = useState<AgentPickerEntry[] | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/agents`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((list: AgentPickerEntry[]) => setAgents(list))
      .catch(() => {
        if (!ctrl.signal.aborted) setAgents([]);
      });
    return () => ctrl.abort();
  }, []);

  // Loading: keep the layout stable while the fetch resolves.
  if (agents === null) {
    return (
      <div className="px-6 py-12 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
        Loading&hellip;
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-soft">
          No agents in your workforce.
        </p>
        <p className="mt-2 text-sm text-ink-faint">
          Recreate one to get started.
        </p>
        <div className="mt-4">
          <Button asChild>
            <Link href="/agents">Create an agent</Link>
          </Button>
        </div>
      </div>
    );
  }

  // Compact rail: just the picker, tighter padding. Non-compact: full
  // landing with copy + picker.
  return (
    <div className={cn("text-center", compact ? "px-3 py-6" : "px-6 py-10")}>
      {!compact && (
        <>
          <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-soft">
            Start a chat
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-faint">
            Pick an agent to begin. Your workforce will populate this page as
            sessions and tasks come online.
          </p>
        </>
      )}
      <ul
        className={cn(
          "mx-auto mt-6 grid gap-2",
          compact ? "max-w-full" : "max-w-md"
        )}
      >
        {agents.map((a) => (
          <li key={a.id}>
            <Link
              href={`/?agent=${encodeURIComponent(a.id)}`}
              className="group flex items-start gap-3 border border-paper-rule bg-paper px-3 py-2.5 text-left transition-colors hover:border-plot-red hover:bg-paper-sunk"
            >
              <MessageSquarePlus
                className="mt-0.5 size-4 shrink-0 text-ink-soft group-hover:text-plot-red"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-ink">
                  {a.name}
                </div>
                {a.role && (
                  <div className="mt-0.5 line-clamp-2 text-[12px] text-ink-soft">
                    {a.role}
                  </div>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HomeView({ compact = false }: { compact?: boolean } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSessionId = searchParams.get("session") ?? null;
  // Filter the three buckets to one agent. URL-backed (`?agentFilter=`)
  // so refresh and shared links survive. Orthogonal to ?session / ?agent
  // — picking a chip never changes which chat is open. Null = show all.
  const agentFilter = searchParams.get("agentFilter");
  const { payload, loading, error, refresh } = useHomeStream();

  // Build a lookup of sessionId → agentId so the row click can pin
  // both into the URL. Without the agent in the URL, opening a
  // session belonging to a different agent would briefly render the
  // chat header with stale agent info.
  const sessionToAgent = new Map<string, string>();
  if (payload) {
    for (const bucket of [payload.waiting, payload.running, payload.idle]) {
      for (const s of bucket) sessionToAgent.set(s.sessionId, s.agentId);
    }
  }

  const pick = (sid: string) => {
    // Canonical URL is `?session=<id>` only — the agent is implied
    // by the session row server-side, the chat page fetches
    // `/api/sessions/:id` and adopts the agent from there.
    navigateClient(`/?session=${encodeURIComponent(sid)}`);
  };

  const deleteSession = async (sid: string) => {
    if (!confirm("Delete this session? Messages and attachments are removed permanently.")) return;
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sid)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      alert(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // If the deleted session is the one currently open in the chat panel,
    // clear it from the URL so the page doesn't try to render a gone session.
    if (sid === activeSessionId) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("session");
      const qs = params.toString();
      navigateClient(qs ? `/?${qs}` : "/");
    }
    void refresh({ force: true });
  };

  const setAgentFilter = (next: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next == null) params.delete("agentFilter");
    else params.set("agentFilter", next);
    const qs = params.toString();
    navigateClient(qs ? `/?${qs}` : "/");
  };

  if (loading && !payload) {
    return (
      <div
        className={cn(
          "flex items-center justify-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint",
          compact
            ? "h-full w-[340px] shrink-0 border-r border-paper-rule"
            : "h-full flex-1"
        )}
      >
        Loading&hellip;
      </div>
    );
  }
  if (error) {
    return (
      <div
        className={cn(
          "px-6 py-8 text-sm text-ink-soft",
          compact
            ? "w-[340px] shrink-0 border-r border-paper-rule"
            : "flex-1"
        )}
      >
        Failed to load home: {error}
      </div>
    );
  }

  const empty =
    !payload ||
    (payload.waiting.length === 0 &&
      payload.running.length === 0 &&
      payload.idle.length === 0);

  return (
    <div
      className={cn(
        "h-full overflow-y-auto bg-paper",
        compact
          ? "w-[340px] shrink-0 border-r border-paper-rule"
          : "flex-1"
      )}
    >
      <div
        className={cn(
          "flex items-start justify-between gap-3 border-b border-paper-rule",
          compact ? "px-3 py-3" : "px-6 py-5"
        )}
      >
        <div className="min-w-0">
          <h1
            className={cn(
              "text-ink",
              compact ? "text-sm font-medium" : "text-lg font-medium"
            )}
          >
            Home
          </h1>
          {!compact && (
            <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
              Workforce activity at a glance
            </p>
          )}
        </div>
        <NewChatPopover compact={compact} />
      </div>

      {!empty && payload && (() => {
        // Per-agent totals from the UNFILTERED payload so chip counts
        // don't zero out when a filter is active.
        const totals = new Map<
          string,
          { name: string; count: number }
        >();
        for (const bucket of [
          payload.waiting,
          payload.running,
          payload.idle,
        ]) {
          for (const s of bucket) {
            const cur = totals.get(s.agentId);
            if (cur) cur.count++;
            else totals.set(s.agentId, { name: s.agentName, count: 1 });
          }
        }
        // Single-agent slot: hide the filter entirely — scoping is
        // noise when there's nothing to scope away from.
        if (totals.size <= 1) return null;
        const agentTotals = Array.from(totals.entries())
          .map(([id, { name, count }]) => ({ id, name, count }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return (
          <div
            className={cn(
              "border-b border-paper-rule",
              compact ? "px-3 py-2" : "px-6 py-3"
            )}
          >
            <FilterByAgentPopover
              agentTotals={agentTotals}
              active={agentFilter}
              onPick={setAgentFilter}
              compact={compact}
            />
          </div>
        );
      })()}

      {empty ? (
        <EmptyState compact={compact} />
      ) : (() => {
        const apply = (b: SessionSummary[]) =>
          agentFilter ? b.filter((s) => s.agentId === agentFilter) : b;
        const w = apply(payload!.waiting);
        const r = apply(payload!.running);
        const i = apply(payload!.idle);
        // Filter active + nothing left in any bucket → tell the user
        // explicitly rather than dropping into a blank pane.
        if (agentFilter && w.length === 0 && r.length === 0 && i.length === 0) {
          const name =
            payload!.waiting.find((s) => s.agentId === agentFilter)?.agentName ??
            payload!.running.find((s) => s.agentId === agentFilter)?.agentName ??
            payload!.idle.find((s) => s.agentId === agentFilter)?.agentName ??
            agentFilter;
          return (
            <div
              className={cn(
                "text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint",
                compact ? "px-3 py-8" : "px-6 py-12"
              )}
            >
              No active sessions for {name}.
            </div>
          );
        }
        return (
          <>
            <Section
              title="Waiting on you"
              hint="oldest first"
              icon={Bell}
              tone="waiting"
              sessions={w}
              onPick={pick}
              onDelete={deleteSession}
              compact={compact}
              activeSessionId={activeSessionId}
            />
            <Section
              title="Running"
              hint="live"
              icon={CircleDot}
              tone="running"
              sessions={r}
              onPick={pick}
              onDelete={deleteSession}
              compact={compact}
              activeSessionId={activeSessionId}
            />
            <Section
              title="Idle"
              hint="with pending work"
              icon={Pause}
              tone="idle"
              sessions={i}
              onPick={pick}
              onDelete={deleteSession}
              compact={compact}
              activeSessionId={activeSessionId}
            />
          </>
        );
      })()}
    </div>
  );
}

