"use client";

import { useState } from "react";
import { Loader2, Save, Trash2, X, Copy, Check } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  formatDate,
  type Recurrence,
  type RecurrenceSession,
  type Task,
  type TaskStatus,
} from "./types";

export interface TaskDetailPanelProps {
  selected: Task;
  draft: Task;
  saving: boolean;
  dirty: boolean;
  onChange: (next: Task) => void;
  onSave: () => void;
  onDeleteClick: () => void;
  /** When provided, renders a close X in the header (modal use). */
  onClose?: () => void;
}

export function TaskDetailPanel({
  selected,
  draft,
  saving,
  dirty,
  onChange,
  onSave,
  onDeleteClick,
  onClose,
}: TaskDetailPanelProps) {
  const [copied, setCopied] = useState(false);
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(selected.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  const shortId = selected.id.slice(0, 8);

  return (
    <>
      {/* Fixed header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-paper-rule bg-paper-sunk px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Task
          </span>
          <button
            type="button"
            onClick={copyId}
            title={`Copy ${selected.id}`}
            aria-label="Copy task ID"
            className="group flex items-center gap-1.5 font-mono text-[12px] tabular-nums text-ink-soft transition-colors hover:text-plot-red focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red"
          >
            <span>{shortId}</span>
            {copied ? (
              <Check className="size-3 text-plot-red" />
            ) : (
              <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost-destructive" disabled={saving} onClick={onDeleteClick}>
            <Trash2 className="size-4" />
            Delete
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="ml-1 p-1 text-ink-soft transition-colors hover:text-plot-red focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select
              value={draft.status}
              onValueChange={(v) =>
                onChange({ ...draft, status: v as TaskStatus })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="assignee">Assignee</Label>
            <Input
              id="assignee"
              value={draft.assignee}
              onChange={(e) => onChange({ ...draft, assignee: e.target.value })}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="start_at">Start at</Label>
            <Input
              id="start_at"
              placeholder="2026-05-15T09:00:00Z"
              value={draft.start_at ?? ""}
              onChange={(e) =>
                onChange({ ...draft, start_at: e.target.value || null })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="due_at">Due at</Label>
            <Input
              id="due_at"
              placeholder="2026-05-20T17:00:00Z"
              value={draft.due_at ?? ""}
              onChange={(e) =>
                onChange({ ...draft, due_at: e.target.value || null })
              }
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="session_id">Session id</Label>
          <Input
            id="session_id"
            placeholder="(unbound)"
            value={draft.session_id ?? ""}
            onChange={(e) =>
              onChange({ ...draft, session_id: e.target.value || null })
            }
          />
        </div>

        <RecurrenceEditor
          value={draft.recurrence}
          onChange={(rec) => onChange({ ...draft, recurrence: rec })}
          runs={selected.runs}
          lastRunAt={selected.last_run_at}
          nextStartAt={selected.start_at}
        />

        <div className="space-y-1.5">
          <Label htmlFor="body">Body</Label>
          <Textarea
            id="body"
            rows={12}
            value={draft.body ?? ""}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
          />
        </div>
      </div>

      {/* Fixed footer with audit metadata */}
      <div className="grid shrink-0 grid-cols-[auto_1fr_auto_1fr] items-baseline gap-x-5 gap-y-1 border-t border-paper-rule bg-paper-sunk px-5 py-3 font-mono text-[12px] tabular-nums">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          By
        </span>
        <span className="truncate text-ink-soft">{selected.created_by}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Created
        </span>
        <span className="text-ink-soft">{formatDate(selected.created_at)}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Updated
        </span>
        <span className="text-ink-soft">{formatDate(selected.updated_at)}</span>
        {selected.closed_at && (
          <>
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Closed
            </span>
            <span className="text-ink-soft">{formatDate(selected.closed_at)}</span>
          </>
        )}
        {selected.depends_on.length > 0 && (
          <>
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Deps
            </span>
            <span className="col-span-3 truncate text-ink-soft">
              {selected.depends_on.map((id) => id.slice(0, 8)).join(", ")}
            </span>
          </>
        )}
        {selected.parent_id && (
          <>
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Parent
            </span>
            <span className="col-span-3 truncate text-ink-soft">
              {selected.parent_id.slice(0, 8)}
            </span>
          </>
        )}
      </div>
    </>
  );
}

type RecurrenceKind = "none" | "cron" | "interval";

function RecurrenceEditor({
  value,
  onChange,
  runs,
  lastRunAt,
  nextStartAt,
}: {
  value: Recurrence | null;
  onChange: (rec: Recurrence | null) => void;
  runs: number;
  lastRunAt: string | null;
  nextStartAt: string | null;
}) {
  const kind: RecurrenceKind = value ? value.kind : "none";

  const setKind = (k: RecurrenceKind) => {
    if (k === "none") {
      onChange(null);
      return;
    }
    if (k === "cron") {
      onChange({
        kind: "cron",
        expr: value && value.kind === "cron" ? value.expr : "0 9 * * *",
        tz: value && value.kind === "cron" ? (value.tz ?? null) : null,
        until: value?.until ?? null,
        count: value?.count ?? null,
        session: value?.session ?? "fresh",
      });
      return;
    }
    onChange({
      kind: "interval",
      every_ms:
        value && value.kind === "interval" ? value.every_ms : 60 * 60 * 1000,
      until: value?.until ?? null,
      count: value?.count ?? null,
      session: value?.session ?? "fresh",
    });
  };

  return (
    <div className="space-y-3 border border-paper-rule bg-paper-sunk p-4">
      <div className="flex items-center justify-between">
        <Label>Recurrence</Label>
        <Select value={kind} onValueChange={(v) => setKind(v as RecurrenceKind)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="cron">Cron</SelectItem>
            <SelectItem value="interval">Interval</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {value && value.kind === "cron" && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="rec-expr">Expression</Label>
            <Input
              id="rec-expr"
              placeholder="0 9 * * 1-5"
              value={value.expr}
              onChange={(e) => onChange({ ...value, expr: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rec-tz">Timezone</Label>
            <Input
              id="rec-tz"
              placeholder="America/Los_Angeles"
              value={value.tz ?? ""}
              onChange={(e) =>
                onChange({ ...value, tz: e.target.value || null })
              }
            />
          </div>
        </div>
      )}

      {value && value.kind === "interval" && (
        <div className="space-y-1.5">
          <Label htmlFor="rec-every">Every (ms)</Label>
          <Input
            id="rec-every"
            type="number"
            min={60_000}
            value={value.every_ms}
            onChange={(e) =>
              onChange({
                ...value,
                every_ms: Number(e.target.value) || 60_000,
              })
            }
          />
          <p className="font-mono text-[11px] text-ink-faint">
            Minimum 60000 (1 minute). 60000=1m, 3600000=1h, 86400000=1d.
          </p>
        </div>
      )}

      {value && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="rec-until">Until (ISO)</Label>
              <Input
                id="rec-until"
                placeholder="2026-12-31T00:00:00Z"
                value={value.until ?? ""}
                onChange={(e) =>
                  onChange({ ...value, until: e.target.value || null })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rec-count">Count cap</Label>
              <Input
                id="rec-count"
                type="number"
                min={1}
                placeholder="(unlimited)"
                value={value.count ?? ""}
                onChange={(e) =>
                  onChange({
                    ...value,
                    count: e.target.value ? Number(e.target.value) : null,
                  })
                }
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Session strategy</Label>
            <Select
              value={value.session}
              onValueChange={(v) =>
                onChange({ ...value, session: v as RecurrenceSession })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fresh">
                  Fresh — new session each fire
                </SelectItem>
                <SelectItem value="reuse">
                  Reuse — continue same session (context accumulates)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-3 gap-4 border-t border-paper-rule pt-3 font-mono text-[12px] tabular-nums">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Runs
              </div>
              <div className="text-ink">{runs}</div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Last run
              </div>
              <div className="text-ink-soft">{lastRunAt ? formatDate(lastRunAt) : "—"}</div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Next fire
              </div>
              <div className="text-ink-soft">{nextStartAt ? formatDate(nextStartAt) : "—"}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
