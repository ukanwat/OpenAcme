"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Kanban, ListChecks, Rows3 } from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import { Skeleton } from "@/app/components/ui/skeleton";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { cn } from "@/app/lib/utils";
import { TasksBoard } from "./board";
import { TaskDetailPanel, type AgentOption } from "./detail";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  STATUS_VARIANT,
  formatDate,
  type Task,
  type TaskStatus,
} from "./types";

type ViewMode = "board" | "list";
const VIEW_MODE_STORAGE_KEY = "openacme.tasks.viewMode";

export default function TasksPage() {
  return (
    <Suspense fallback={null}>
      <TasksPageInner />
    </Suspense>
  );
}

function TasksPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlId = searchParams.get("id");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Task | null>(null);
  const [draft, setDraft] = useState<Task | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("board");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (stored === "list" || stored === "board") setViewMode(stored);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    void loadAgents(ctrl.signal);
    return () => ctrl.abort();
  }, []);

  // URL → selection state. /tasks/<id> loads that task; /tasks resets.
  useEffect(() => {
    if (urlId) {
      void loadOne(urlId);
    } else {
      setSelected(null);
      setDraft(null);
    }
  }, [urlId]);

  const load = async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/tasks`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { tasks: Task[] };
      setTasks(json.tasks);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load tasks");
    } finally {
      setLoading(false);
    }
  };

  const loadAgents = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/agents`, { signal });
      if (!res.ok) return;
      const list = (await res.json()) as { id: string; name: string }[];
      setAgents(list.map((a) => ({ id: a.id, name: a.name })));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // non-fatal: assignee select falls back to current value
    }
  };

  const loadOne = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { task: Task };
      setSelected(json.task);
      setDraft(json.task);
    } catch {
      toast.error("Failed to load task");
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        title: draft.title,
        body: draft.body ?? "",
        status: draft.status,
        assignee: draft.assignee,
        session_id: draft.session_id,
        start_at: draft.start_at,
        due_at: draft.due_at,
        recurrence: draft.recurrence,
      };
      const res = await fetch(`${API_BASE}/api/tasks/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { task: Task };
      setSelected(json.task);
      setDraft(json.task);
      await load();
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Drag-end handler for board mode: optimistic move, PATCH status, revert on error.
  const moveStatus = async (id: string, target: TaskStatus) => {
    const before = tasks;
    const current = before.find((t) => t.id === id);
    if (!current) return;
    setTasks(before.map((t) => (t.id === id ? { ...t, status: target } : t)));
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: target }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { task: Task };
      // The store may auto-correct (e.g., back to blocked if deps unmet).
      if (json.task.status !== target) {
        toast.message(
          `Auto-corrected to ${STATUS_LABEL[json.task.status]}`,
          { description: explainAutoCorrect(json.task.status, target) }
        );
      }
      await load();
      // If the moved task was the selected one, refresh detail view too.
      if (selected?.id === id) {
        setSelected(json.task);
        setDraft(json.task);
      }
    } catch (e) {
      setTasks(before);
      toast.error((e as Error).message);
    }
  };

  const remove = async (id: string, force: boolean) => {
    try {
      const res = await fetch(
        `${API_BASE}/api/tasks/${id}${force ? "?force=true" : ""}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        if (err.error === "has_dependents") {
          return false;
        }
        throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
      }
      const wasSelected = selected?.id === id;
      await load();
      toast.success("Deleted");
      setConfirmDelete(null);
      if (wasSelected) router.push("/tasks");
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };

  const grouped = useMemo(() => {
    const out = new Map<TaskStatus, Task[]>();
    for (const s of STATUS_ORDER) out.set(s, []);
    for (const t of tasks) {
      out.get(t.status)?.push(t);
    }
    for (const list of out.values()) {
      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    return out;
  }, [tasks]);

  const dirty = !!(
    draft &&
    selected &&
    (draft.title !== selected.title ||
      (draft.body ?? "") !== (selected.body ?? "") ||
      draft.status !== selected.status ||
      draft.assignee !== selected.assignee ||
      (draft.session_id ?? null) !== (selected.session_id ?? null) ||
      (draft.start_at ?? null) !== (selected.start_at ?? null) ||
      (draft.due_at ?? null) !== (selected.due_at ?? null) ||
      JSON.stringify(draft.recurrence) !== JSON.stringify(selected.recurrence))
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-paper-rule px-6">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Tasks
            </span>
            <span className="h-3 w-px bg-paper-rule" aria-hidden />
            <span className="font-mono text-[12px] tabular-nums text-ink-soft">
              {tasks.length} filed
            </span>
            <span className="font-mono text-[11px] text-ink-faint">
              · agents file and complete; you observe
            </span>
          </div>
          <div className="inline-flex border border-paper-rule">
            <button
              onClick={() => setViewMode("board")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors",
                viewMode === "board"
                  ? "bg-ink text-paper"
                  : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink"
              )}
            >
              <Kanban className="size-3.5" />
              Board
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 border-l border-paper-rule px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors",
                viewMode === "list"
                  ? "bg-ink text-paper"
                  : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink"
              )}
            >
              <Rows3 className="size-3.5" />
              List
            </button>
          </div>
        </header>

        {loading ? (
          <div className="space-y-px p-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : tasks.length === 0 ? (
          <EmptyTasksState />
        ) : viewMode === "board" ? (
          <>
            <TasksBoard
              tasks={tasks}
              selectedId={selected?.id ?? null}
              onPick={(id) => router.push(`/tasks?id=${id}`)}
              onMove={(id, target) => void moveStatus(id, target)}
            />
            <Dialog
              open={!!selected && !!draft}
              onOpenChange={(open) => {
                if (!open) router.push("/tasks");
              }}
            >
              <DialogContent
                showCloseButton={false}
                className="max-h-[85vh] max-w-3xl overflow-hidden"
              >
                <VisuallyHidden.Root>
                  <DialogTitle>{selected?.title ?? "Task"}</DialogTitle>
                  <DialogDescription>
                    Edit task details — title, status, assignee, schedule,
                    recurrence, and body.
                  </DialogDescription>
                </VisuallyHidden.Root>
                {selected && draft && (
                  <TaskDetailPanel
                    selected={selected}
                    draft={draft}
                    saving={saving}
                    dirty={dirty}
                    agents={agents}
                    onChange={setDraft}
                    onSave={() => void save()}
                    onDeleteClick={() => setConfirmDelete(selected.id)}
                    onClose={() => router.push("/tasks")}
                  />
                )}
              </DialogContent>
            </Dialog>
          </>
        ) : (
          <div className="flex flex-1 overflow-hidden">
            <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-r border-paper-rule">
              {STATUS_ORDER.map((status) => {
                const items = grouped.get(status) ?? [];
                if (items.length === 0) return null;
                return (
                  <div key={status}>
                    <div className="flex items-center justify-between border-b border-paper-rule px-4 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                      <span>{STATUS_LABEL[status]}</span>
                      <span className="tabular-nums">{items.length}</span>
                    </div>
                    <div className="flex flex-col">
                      {items.map((t) => {
                        const isActive = selected?.id === t.id;
                        return (
                          <button
                            key={t.id}
                            onClick={() => router.push(`/tasks?id=${t.id}`)}
                            className={cn(
                              "group relative flex flex-col items-start gap-1 border-b border-paper-rule px-4 py-3 text-left transition-colors",
                              isActive
                                ? "bg-paper-sunk text-ink"
                                : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
                            )}
                          >
                            <span
                              className={cn(
                                "absolute inset-y-0 left-0 w-[2px] bg-plot-red transition-opacity",
                                isActive ? "opacity-100" : "opacity-0"
                              )}
                              aria-hidden
                            />
                            <div className="flex w-full items-center gap-2">
                              <Badge
                                variant={STATUS_VARIANT[t.status]}
                                className="shrink-0"
                              >
                                {STATUS_LABEL[t.status]}
                              </Badge>
                              <span className="truncate text-sm font-medium text-ink">
                                {t.title}
                              </span>
                            </div>
                            <div className="flex w-full flex-wrap gap-x-3 font-mono text-[11px] tabular-nums text-ink-faint">
                              <span>@{t.assignee}</span>
                              {t.due_at && (
                                <span>due {formatDate(t.due_at)}</span>
                              )}
                              {t.start_at && (
                                <span>starts {formatDate(t.start_at)}</span>
                              )}
                              {t.depends_on.length > 0 && (
                                <span>
                                  {t.depends_on.length} dep
                                  {t.depends_on.length === 1 ? "" : "s"}
                                </span>
                              )}
                              {t.comment_count !== undefined &&
                                t.comment_count > 0 && (
                                  <span>
                                    {t.comment_count} comment
                                    {t.comment_count === 1 ? "" : "s"}
                                  </span>
                                )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </aside>

            <section className="flex flex-1 flex-col overflow-hidden">
              {!selected || !draft ? (
                <div className="flex flex-1 items-start justify-center pt-24 px-6">
                  <div className="max-w-sm">
                    <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                      No selection
                    </div>
                    <h3 className="mt-2 text-base font-semibold text-ink">
                      Pick a task
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                      Each task has a title, status, assignee, schedule, and
                      free-form body. Status changes are gated by dependencies.
                    </p>
                  </div>
                </div>
              ) : (
                <TaskDetailPanel
                  selected={selected}
                  draft={draft}
                  saving={saving}
                  dirty={dirty}
                  agents={agents}
                  onChange={setDraft}
                  onSave={() => void save()}
                  onDeleteClick={() => setConfirmDelete(selected.id)}
                />
              )}
            </section>
          </div>
        )}

        <Dialog
          open={!!confirmDelete}
          onOpenChange={(open) => {
            if (!open) setConfirmDelete(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this task?</DialogTitle>
              <DialogDescription>
                Permanent. If other tasks depend on this one, you&apos;ll be asked
                whether to cascade.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={async () => {
                  if (!confirmDelete) return;
                  const ok = await remove(confirmDelete, false);
                  if (!ok) {
                    if (
                      window.confirm(
                        "Other tasks depend on this one. Cascade delete?"
                      )
                    ) {
                      await remove(confirmDelete, true);
                    } else {
                      setConfirmDelete(null);
                    }
                  }
                }}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}

function explainAutoCorrect(actual: TaskStatus, requested: TaskStatus): string {
  if (actual === "blocked" && requested === "open") {
    return "Dependencies aren't all done yet.";
  }
  return `Server returned status ${actual} instead of ${requested}.`;
}

type TaskState = "open" | "in_progress" | "done";
const TASK_STATE_CYCLE: { state: TaskState; label: string; ms: number }[] = [
  { state: "open",        label: "OPEN",        ms: 1400 },
  { state: "in_progress", label: "IN PROGRESS", ms: 1400 },
  { state: "done",        label: "DONE",        ms: 1400 },
];

function EmptyTasksState() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setIdx((i) => (i + 1) % TASK_STATE_CYCLE.length);
    }, TASK_STATE_CYCLE[0]!.ms);
    return () => clearInterval(t);
  }, []);
  const current = TASK_STATE_CYCLE[idx]!;
  const dotClass =
    current.state === "open"
      ? "bg-signal-amber"
      : current.state === "in_progress"
        ? "bg-plot-red pulse-live"
        : "bg-ink";
  return (
    <div className="mx-auto w-full max-w-2xl px-6 pt-12">
      <SectionEyebrow meta="0 tasks">Empty board</SectionEyebrow>

      <div className="mt-6 border border-paper-rule paper-surface px-4 py-4 section-enter">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[13px] text-ink truncate">
              investigate failing build on main
            </div>
            <div className="mt-1 meta-row">
              agent_8f3a2b · filed 2m ago
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span aria-hidden className={cn("status-dot", dotClass)} />
            <span key={idx} className="label-faceplate tick">
              {current.label}
            </span>
          </div>
        </div>
      </div>

      <p className="mt-5 text-[13px] leading-relaxed text-ink-soft">
        Tasks are how agents track work — for themselves and for you.
        Each one moves between{" "}
        <span className="font-mono text-ink">open</span>,{" "}
        <span className="font-mono text-ink">in_progress</span>, and{" "}
        <span className="font-mono text-ink">done</span>. They appear
        here as agents file them. Ask an agent in chat to{" "}
        <span className="font-mono text-ink">
          file a task to investigate X
        </span>{" "}
        to start.
      </p>
    </div>
  );
}
