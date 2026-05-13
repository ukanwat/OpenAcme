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
import { useRouter, useSearchParams } from "next/navigation";
import { Bell, CircleDot, Pause, Bot, Clock } from "lucide-react";
import { useHomeStream } from "@/app/lib/useHomeStream";
import type { SessionSummary } from "@/app/lib/types";
import { cn } from "@/app/lib/utils";

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

function formatNextCheck(unixSeconds: number | null): string | null {
  if (unixSeconds == null) return null;
  const now = Math.floor(Date.now() / 1000);
  const diff = unixSeconds - now;
  if (diff <= 0) return "due now";
  if (diff < 60) return `wakes ${diff}s`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `wakes ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `wakes ${h}h`;
  const d = Math.floor(h / 24);
  return `wakes ${d}d`;
}

interface RowProps {
  s: SessionSummary;
  onClick: () => void;
  compact: boolean;
  active: boolean;
}

function SessionRow({ s, onClick, compact, active }: RowProps) {
  const wakeLabel = formatNextCheck(s.nextCheckAt);
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

  if (compact) {
    return (
      <button
        onClick={onClick}
        className={cn(
          "group flex w-full items-start gap-2 border-b border-paper-rule px-3 py-2 text-left transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "hover:bg-sidebar-accent/40"
        )}
      >
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
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-full items-start gap-4 border-b border-paper-rule px-6 py-3 text-left transition-colors",
        "hover:bg-sidebar-accent/40"
      )}
    >
      <div className="flex w-32 shrink-0 items-center gap-2 pt-0.5">
        <span className={cn("status-dot", statusDot)} aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft">
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
    </button>
  );
}

function Section({
  title,
  hint,
  icon: Icon,
  sessions,
  onPick,
  compact,
  activeSessionId,
}: {
  title: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  sessions: SessionSummary[];
  onPick: (sid: string) => void;
  compact: boolean;
  activeSessionId: string | null;
}) {
  if (sessions.length === 0) return null;
  return (
    <section className={compact ? "mt-3" : "mt-6"}>
      <div
        className={cn(
          "flex items-center justify-between pb-2",
          compact ? "px-3" : "px-6"
        )}
      >
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.10em] text-ink-soft">
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
            compact={compact}
            active={activeSessionId === s.sessionId}
          />
        ))}
      </div>
    </section>
  );
}

export function HomeView({ compact = false }: { compact?: boolean } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSessionId = searchParams.get("session") ?? null;
  const { payload, loading, error } = useHomeStream();

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
    const aid = sessionToAgent.get(sid);
    const qs = aid
      ? `session=${encodeURIComponent(sid)}&agent=${encodeURIComponent(aid)}`
      : `session=${encodeURIComponent(sid)}`;
    router.push(`/?${qs}`);
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
          "border-b border-paper-rule",
          compact ? "px-3 py-3" : "px-6 py-5"
        )}
      >
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

      {empty ? (
        <div className="px-6 py-12 text-center">
          <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-soft">
            Nothing&apos;s running right now.
          </p>
          <p className="mt-2 text-sm text-ink-faint">
            Create an agent, give it a task, and this page will fill in as
            work happens.
          </p>
        </div>
      ) : (
        <>
          <Section
            title="Waiting on you"
            hint="oldest first"
            icon={Bell}
            sessions={payload!.waiting}
            onPick={pick}
            compact={compact}
            activeSessionId={activeSessionId}
          />
          <Section
            title="Running"
            hint="live"
            icon={CircleDot}
            sessions={payload!.running}
            onPick={pick}
            compact={compact}
            activeSessionId={activeSessionId}
          />
          <Section
            title="Idle"
            hint="with pending work"
            icon={Pause}
            sessions={payload!.idle}
            onPick={pick}
            compact={compact}
            activeSessionId={activeSessionId}
          />
        </>
      )}
    </div>
  );
}
