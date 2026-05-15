import { z } from "zod";
import {
  TASK_STATUSES,
  TaskStore,
  TaskStoreError,
  type Recurrence,
  type Task,
  type TaskStatus,
} from "@openacme/tasks";
import { registry } from "../registry.js";
import { getCurrentAgentId, getCurrentSessionId } from "../session-context.js";

// Recurrence shape for tool params — describes the same data as
// @openacme/tasks RecurrenceSchema but with prose `.describe()` strings
// the LLM can read off the tool spec.
const RecurrenceParamsSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cron"),
      expr: z
        .string()
        .min(1)
        .describe(
          'Cron expression, e.g. "0 9 * * 1-5" (every weekday 9am).'
        ),
      tz: z
        .string()
        .nullable()
        .optional()
        .describe('IANA timezone, e.g. "America/Los_Angeles". Optional.'),
      until: z
        .string()
        .nullable()
        .optional()
        .describe("ISO 8601 stop time. Optional."),
      count: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("Stop after this many successful completions. Optional."),
      session: z
        .enum(["fresh", "reuse"])
        .default("fresh")
        .describe(
          '"fresh" (default) creates a new session for each fire — clean isolation. ' +
            '"reuse" continues in the same session — context accumulates across fires.'
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interval"),
      every_ms: z
        .number()
        .int()
        .min(60_000)
        .describe(
          "Milliseconds between fires. Minimum 60000 (1 minute)."
        ),
      until: z.string().nullable().optional(),
      count: z.number().int().positive().nullable().optional(),
      session: z.enum(["fresh", "reuse"]).default("fresh"),
    })
    .strict(),
]);

export interface TaskStoreBindings {
  store: TaskStore;
}

let bindings: TaskStoreBindings | null = null;

export function bindTaskStore(b: TaskStoreBindings): void {
  bindings = b;
}

function requireBindings(): TaskStoreBindings | { error: string } {
  if (!bindings) {
    return {
      error: "tasks not initialized — AgentManager must call bindTaskStore().",
    };
  }
  return bindings;
}

function frontmatterOnly(t: Task) {
  const { body: _body, ...rest } = t;
  void _body;
  return rest;
}

// ── task_list ────────────────────────────────────────────────────────

const TASK_LIST_DESCRIPTION =
  "List tasks. Defaults to YOUR open tasks (assignee = you, excluding done/canceled). " +
  "Pass `assignee` to query another agent's queue, or `status` to filter. " +
  "Returns frontmatter only — call task_view for the full body.";

registry.register({
  name: "task_list",
  toolset: "tasks",
  description: TASK_LIST_DESCRIPTION,
  parameters: z.object({
    assignee: z
      .string()
      .optional()
      .describe("Agent id to filter by. Defaults to the current agent."),
    status: z
      .union([z.enum(TASK_STATUSES), z.array(z.enum(TASK_STATUSES))])
      .optional()
      .describe("Status filter. Defaults to non-terminal (open, in_progress, blocked)."),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Max number of results. Default 50."),
  }),
  emoji: "📋",
  parallelSafe: true,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });

    const a = args as {
      assignee?: string;
      status?: TaskStatus | TaskStatus[];
      limit?: number;
    };
    const agentId = getCurrentAgentId();
    const assignee = a.assignee ?? agentId;
    if (!assignee) {
      return JSON.stringify({
        ok: false,
        error: "task_list requires an active agent context or explicit assignee.",
      });
    }

    const status: TaskStatus[] | undefined = a.status
      ? Array.isArray(a.status)
        ? a.status
        : [a.status]
      : (["open", "in_progress", "blocked"] as TaskStatus[]);

    const all = b.store.list({ assignee, status });
    const limited = all.slice(0, a.limit ?? 50);
    return JSON.stringify({
      ok: true,
      count: limited.length,
      total: all.length,
      tasks: limited.map(frontmatterOnly),
    });
  },
});

// ── task_view ────────────────────────────────────────────────────────

const TASK_VIEW_DESCRIPTION =
  "Read a task by id. Returns frontmatter + the full markdown body (description / notes).";

registry.register({
  name: "task_view",
  toolset: "tasks",
  description: TASK_VIEW_DESCRIPTION,
  parameters: z.object({
    id: z.string().min(1).describe("Task id."),
  }),
  emoji: "🔍",
  parallelSafe: true,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });

    const a = args as { id: string };
    const task = b.store.get(a.id);
    if (!task) {
      return JSON.stringify({ ok: false, error: `Task ${a.id} not found.` });
    }
    return JSON.stringify({ ok: true, task });
  },
});

// ── task_create ──────────────────────────────────────────────────────

const TASK_CREATE_DESCRIPTION =
  "Create a task. The current agent is recorded as `created_by`. " +
  "By default, the task gets a fresh session lazily allocated when the scheduler activates it. " +
  "Pass `sameSession: true` to bind the task to YOUR current session — only honored when " +
  "you're also the assignee. Cross-agent tasks always get a new session for the assignee.\n\n" +
  "Use `start_at` (ISO timestamp) to schedule a future autonomous start. " +
  "Use `depends_on` to gate this task on others (cycle-checked; unmet deps force `blocked`).\n\n" +
  "RECURRING TASKS: pass `recurrence` to fire on a schedule. When you mark a recurring " +
  "task `done` via task_update, it self-resets to `open` with the next fire time — the " +
  "returned status will be `open`, not `done`. Use `status: \"canceled\"` to stop a " +
  "recurrence permanently. Choose `recurrence.session: \"reuse\"` to keep context across " +
  "fires (one ongoing session) or `\"fresh\"` (default) for clean isolation each fire.";

registry.register({
  name: "task_create",
  toolset: "tasks",
  description: TASK_CREATE_DESCRIPTION,
  parameters: z.object({
    title: z.string().min(1).max(500).describe("Short, action-oriented title."),
    assignee: z
      .string()
      .min(1)
      .describe("Agent id to do the work. Required — no unassigned tasks."),
    body: z
      .string()
      .optional()
      .describe(
        "Markdown description / acceptance criteria / working notes."
      ),
    parent_id: z
      .string()
      .optional()
      .describe("Parent task id (for subtask hierarchy)."),
    depends_on: z
      .array(z.string())
      .optional()
      .describe(
        "Task ids that must reach `done` before this one can start."
      ),
    start_at: z
      .string()
      .optional()
      .describe("ISO 8601 timestamp. Task won't activate until this time."),
    due_at: z
      .string()
      .optional()
      .describe("ISO 8601 soft deadline."),
    sameSession: z
      .boolean()
      .optional()
      .describe(
        "Bind to your current session (only when assignee == you). Default false."
      ),
    recurrence: RecurrenceParamsSchema.optional().describe(
      "Schedule the task to fire repeatedly. Marking it done schedules the next fire; cancel to stop."
    ),
  }),
  emoji: "🆕",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });

    const a = args as {
      title: string;
      assignee: string;
      body?: string;
      parent_id?: string;
      depends_on?: string[];
      start_at?: string;
      due_at?: string;
      sameSession?: boolean;
      recurrence?: Recurrence;
    };
    const agentId = getCurrentAgentId();
    if (!agentId) {
      return JSON.stringify({
        ok: false,
        error: "task_create requires an active agent context (only agents create tasks).",
      });
    }

    const isSelfAssign = a.assignee === agentId;
    const sessionId =
      a.sameSession && isSelfAssign ? getCurrentSessionId() ?? null : null;

    // Subtask: if assignee matches the parent's, inherit parent's session.
    let inheritedSession = sessionId;
    if (a.parent_id) {
      const parent = b.store.get(a.parent_id);
      if (parent && parent.assignee === a.assignee && !inheritedSession) {
        inheritedSession = parent.session_id;
      }
    }

    try {
      const task = await b.store.create({
        title: a.title,
        assignee: a.assignee,
        created_by: agentId,
        body: a.body,
        parent_id: a.parent_id ?? null,
        depends_on: a.depends_on ?? [],
        start_at: a.start_at ?? undefined,
        due_at: a.due_at ?? null,
        session_id: inheritedSession,
        recurrence: a.recurrence ?? null,
      });
      const warnings: string[] = [];
      if (a.sameSession && !isSelfAssign) {
        warnings.push(
          "sameSession was ignored: only honored when assignee == you."
        );
      }
      if (task.status === "blocked") {
        warnings.push(
          "Task created in `blocked` status because depends_on are not yet done."
        );
      }
      return JSON.stringify({
        ok: true,
        task: frontmatterOnly(task),
        warnings: warnings.length ? warnings : undefined,
      });
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error:
          e instanceof TaskStoreError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  },
});

// ── task_update ──────────────────────────────────────────────────────

const TASK_UPDATE_DESCRIPTION =
  "Patch a task. Common uses:\n" +
  "- Mark progress: `status: \"in_progress\"`, `\"done\"`, `\"canceled\"`.\n" +
  "- Append notes to body — pass the FULL replacement body (not a diff).\n" +
  "- Reassign: change `assignee`. Clears `session_id` automatically (the new " +
  "  assignee's sessions are different).\n" +
  "- Rebind: pass `session_id` (use null to detach).\n" +
  "- Set / change / strip `recurrence` (pass null to make a recurring task one-shot).\n\n" +
  "When you mark a non-recurring task `done`, dependents auto-flip from blocked to open. " +
  "When you mark a RECURRING task `done`, the task self-resets to `open` with the next " +
  "fire time — the returned status will be `open` (not `done`) and `runs` will increment. " +
  "Use `status: \"canceled\"` to stop a recurrence permanently.";

registry.register({
  name: "task_update",
  toolset: "tasks",
  description: TASK_UPDATE_DESCRIPTION,
  parameters: z.object({
    id: z.string().min(1).describe("Task id."),
    title: z.string().max(500).optional(),
    body: z.string().optional().describe("Replacement body (markdown)."),
    status: z.enum(TASK_STATUSES).optional(),
    assignee: z
      .string()
      .optional()
      .describe("New assignee. Clears session_id unless you also pass session_id."),
    session_id: z
      .string()
      .nullable()
      .optional()
      .describe("Bind to a session, or null to detach."),
    depends_on: z.array(z.string()).optional(),
    start_at: z.string().nullable().optional(),
    due_at: z.string().nullable().optional(),
    recurrence: RecurrenceParamsSchema.nullable()
      .optional()
      .describe("Set/change recurrence; pass null to strip and make one-shot."),
  }),
  emoji: "✏️",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });

    const a = args as {
      id: string;
      title?: string;
      body?: string;
      status?: TaskStatus;
      assignee?: string;
      session_id?: string | null;
      depends_on?: string[];
      start_at?: string | null;
      due_at?: string | null;
      recurrence?: Recurrence | null;
    };
    const agentId = getCurrentAgentId();
    if (!agentId) {
      return JSON.stringify({
        ok: false,
        error: "task_update requires an active agent context.",
      });
    }

    try {
      const task = await b.store.update(a.id, {
        title: a.title,
        body: a.body,
        status: a.status,
        assignee: a.assignee,
        ...(Object.prototype.hasOwnProperty.call(a, "session_id")
          ? { session_id: a.session_id }
          : {}),
        depends_on: a.depends_on,
        start_at: a.start_at,
        due_at: a.due_at,
        ...(Object.prototype.hasOwnProperty.call(a, "recurrence")
          ? { recurrence: a.recurrence }
          : {}),
      });
      return JSON.stringify({ ok: true, task: frontmatterOnly(task) });
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error:
          e instanceof TaskStoreError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  },
});
