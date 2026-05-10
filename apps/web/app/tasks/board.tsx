"use client";

import { useMemo } from "react";
import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Repeat2 } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { Badge } from "@/app/components/ui/badge";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  formatDate,
  shortRecurrenceLabel,
  type Task,
  type TaskStatus,
} from "./types";

export interface TasksBoardProps {
  tasks: Task[];
  selectedId: string | null;
  onPick: (id: string) => void;
  onMove: (id: string, target: TaskStatus) => void;
}

export function TasksBoard({ tasks, selectedId, onPick, onMove }: TasksBoardProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

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

  const handleDragEnd = (e: DragEndEvent) => {
    const id = e.active.id as string;
    const target = e.over?.id as string | undefined;
    if (!target) return;
    if (!STATUS_ORDER.includes(target as TaskStatus)) return;
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    if (t.status === target) return;
    onMove(id, target as TaskStatus);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex flex-1 gap-3 overflow-x-auto p-3">
        {STATUS_ORDER.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={grouped.get(status) ?? []}
            selectedId={selectedId}
            onPick={onPick}
          />
        ))}
      </div>
    </DndContext>
  );
}

function BoardColumn({
  status,
  tasks,
  selectedId,
  onPick,
}: {
  status: TaskStatus;
  tasks: Task[];
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const ids = useMemo(() => tasks.map((t) => t.id), [tasks]);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-72 shrink-0 flex-col border border-paper-rule bg-paper-sunk transition-colors",
        isOver && "border-plot-red"
      )}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-paper-rule bg-paper px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          {STATUS_LABEL[status]}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-ink-soft">
          {tasks.length}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {tasks.length === 0 ? (
            <div className="px-2 py-6 text-center font-mono text-[11px] text-ink-faint">
              empty
            </div>
          ) : (
            tasks.map((t) => (
              <BoardCard
                key={t.id}
                task={t}
                selected={selectedId === t.id}
                onPick={onPick}
              />
            ))
          )}
        </SortableContext>
      </div>
    </div>
  );
}

function BoardCard({
  task,
  selected,
  onPick,
}: {
  task: Task;
  selected: boolean;
  onPick: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      onClick={() => onPick(task.id)}
      className={cn(
        "relative border border-paper-rule bg-paper px-3 py-2 text-left transition-colors hover:bg-paper-sunk",
        selected && "border-plot-red",
        isDragging && "opacity-50"
      )}
      {...attributes}
      {...listeners}
    >
      <div className="space-y-1">
        <div className="line-clamp-1 text-sm font-medium text-ink">{task.title}</div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-ink-faint">
          <span>@{task.assignee}</span>
          {task.due_at && <span>due {formatDate(task.due_at)}</span>}
          {task.start_at && <span>starts {formatDate(task.start_at)}</span>}
          {task.depends_on.length > 0 && (
            <span>
              {task.depends_on.length} dep
              {task.depends_on.length === 1 ? "" : "s"}
            </span>
          )}
          {task.recurrence && (
            <span className="inline-flex items-center gap-0.5">
              <Repeat2 className="size-3" />
              {shortRecurrenceLabel(task.recurrence)}
              {task.runs > 0 && ` · ${task.runs}×`}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
