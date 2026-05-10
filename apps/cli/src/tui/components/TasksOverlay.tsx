import { Box, Text, useInput } from "ink";
import { useMemo } from "react";
import type { Task, TaskStore } from "@openacme/tasks";

const STATUS_ORDER = [
  "in_progress",
  "open",
  "blocked",
  "done",
  "canceled",
] as const;
const STATUS_LABEL: Record<(typeof STATUS_ORDER)[number], string> = {
  in_progress: "in progress",
  open: "open",
  blocked: "blocked",
  done: "done",
  canceled: "canceled",
};

export function TasksOverlay({
  agentId,
  taskStore,
  onClose,
}: {
  agentId: string;
  taskStore: TaskStore;
  onClose: () => void;
}) {
  useInput((_, key) => {
    if (key.escape) onClose();
  });

  const tasks = useMemo(() => taskStore.byAssignee(agentId), [agentId, taskStore]);
  const grouped = useMemo(() => {
    const out = new Map<(typeof STATUS_ORDER)[number], Task[]>();
    for (const s of STATUS_ORDER) out.set(s, []);
    for (const t of tasks) {
      const list = out.get(t.status as (typeof STATUS_ORDER)[number]);
      if (list) list.push(t);
    }
    for (const list of out.values()) {
      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    return out;
  }, [tasks]);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color="magenta">
        Tasks for {agentId} ({tasks.length})
      </Text>
      {tasks.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>(no tasks)</Text>
        </Box>
      ) : (
        STATUS_ORDER.map((status) => {
          const items = grouped.get(status) ?? [];
          if (items.length === 0) return null;
          return (
            <Box key={status} flexDirection="column" marginTop={1}>
              <Text color="cyan">
                {STATUS_LABEL[status]} ({items.length})
              </Text>
              {items.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>Esc to close</Text>
      </Box>
    </Box>
  );
}

function TaskRow({ task }: { task: Task }) {
  const shortId = task.id.slice(0, 8);
  const recurrence = task.recurrence ? formatRecurrence(task) : null;
  const blocked =
    task.status === "blocked" && task.depends_on.length > 0
      ? `↳ blocked on ${task.depends_on.map((d) => d.slice(0, 8)).join(", ")}`
      : null;
  return (
    <Box>
      <Text dimColor>{`  [${shortId}] `}</Text>
      <Text>{task.title}</Text>
      {recurrence && <Text color="yellow">{`  ⟲ ${recurrence}`}</Text>}
      {blocked && <Text dimColor>{`  ${blocked}`}</Text>}
    </Box>
  );
}

function formatRecurrence(task: Task): string {
  const rec = task.recurrence!;
  const cadence =
    rec.kind === "cron"
      ? rec.tz
        ? `cron ${rec.expr} (${rec.tz})`
        : `cron ${rec.expr}`
      : `every ${formatMs(rec.every_ms)}`;
  return task.runs > 0 ? `${cadence}  ran ${task.runs}×` : cadence;
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}
