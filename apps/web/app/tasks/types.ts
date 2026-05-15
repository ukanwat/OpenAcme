export type TaskStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "done"
  | "canceled";

// mirrored (not imported) — keep in sync with @openacme/tasks Recurrence
export type RecurrenceSession = "fresh" | "reuse";
export type Recurrence =
  | {
      kind: "cron";
      expr: string;
      tz?: string | null;
      until?: string | null;
      count?: number | null;
      session: RecurrenceSession;
    }
  | {
      kind: "interval";
      every_ms: number;
      until?: string | null;
      count?: number | null;
      session: RecurrenceSession;
    };

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string;
  session_id: string | null;
  created_by: string;
  parent_id: string | null;
  depends_on: string[];
  start_at: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  recurrence: Recurrence | null;
  runs: number;
  last_run_at: string | null;
  body?: string;
}

export const STATUS_ORDER: TaskStatus[] = [
  "in_progress",
  "open",
  "blocked",
  "done",
  "canceled",
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  in_progress: "In progress",
  open: "Open",
  blocked: "Blocked",
  done: "Done",
  canceled: "Canceled",
};

export const STATUS_VARIANT: Record<
  TaskStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  in_progress: "default",
  open: "secondary",
  blocked: "outline",
  done: "outline",
  canceled: "destructive",
};

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function shortRecurrenceLabel(rec: Recurrence): string {
  if (rec.kind === "cron") {
    return rec.tz ? `${rec.expr} (${rec.tz})` : rec.expr;
  }
  return formatMs(rec.every_ms);
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `every ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `every ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `every ${h}h`;
  const d = Math.round(h / 24);
  return `every ${d}d`;
}
