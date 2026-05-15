import type { Hono } from "hono";
import { TaskStoreError, TASK_STATUSES, type TaskStatus } from "@openacme/tasks";
import type { AgentManager } from "../agent-manager.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function statusErrorCode(code: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "has_dependents":
      return 409;
    case "session_busy":
      return 409;
    case "deps_unsatisfied":
      return 409;
    case "cycle":
      return 400;
    case "unknown_deps":
      return 400;
    case "unknown_parent":
      return 400;
    case "invalid_id":
      return 400;
    default:
      return 400;
  }
}

function asStatusFilter(v: string | undefined): TaskStatus[] | undefined {
  if (!v) return undefined;
  const parts = v.split(",").map((p) => p.trim()).filter(Boolean);
  const valid = parts.filter((p): p is TaskStatus =>
    (TASK_STATUSES as readonly string[]).includes(p)
  );
  if (valid.length === 0) return undefined;
  return valid;
}

export function registerTaskRoutes(app: Hono, manager: AgentManager): void {
  // GET /api/tasks
  app.get("/api/tasks", (c) => {
    const url = new URL(c.req.url);
    const assignee = url.searchParams.get("assignee") ?? undefined;
    const created_by = url.searchParams.get("created_by") ?? undefined;
    const session_id_raw = url.searchParams.get("session_id");
    const status = asStatusFilter(url.searchParams.get("status") ?? undefined);

    const session_id =
      session_id_raw === "null"
        ? null
        : session_id_raw ?? undefined;

    const tasks = manager.taskStore.list({
      assignee,
      created_by,
      ...(session_id !== undefined ? { session_id } : {}),
      status,
    });
    // Strip body for the list view; clients hit GET /:id for the body.
    return c.json({
      tasks: tasks.map(({ body: _body, ...rest }) => {
        void _body;
        return rest;
      }),
    });
  });

  // GET /api/tasks/:id
  app.get("/api/tasks/:id", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const task = manager.taskStore.get(id);
    if (!task) return c.json({ error: "not_found" }, 404);
    return c.json({ task });
  });

  // PATCH /api/tasks/:id — founder edit. Accepts session_id directly.
  app.patch("/api/tasks/:id", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const patch: Parameters<typeof manager.taskStore.update>[1] = {};
    if (typeof body["title"] === "string") patch.title = body["title"];
    if (typeof body["body"] === "string") patch.body = body["body"];
    if (typeof body["status"] === "string") {
      if (!(TASK_STATUSES as readonly string[]).includes(body["status"])) {
        return c.json({ error: "invalid status" }, 400);
      }
      patch.status = body["status"] as TaskStatus;
    }
    if (typeof body["assignee"] === "string") patch.assignee = body["assignee"];
    if (Object.prototype.hasOwnProperty.call(body, "session_id")) {
      const sid = body["session_id"];
      if (sid === null) patch.session_id = null;
      else if (typeof sid === "string") patch.session_id = sid;
      else return c.json({ error: "invalid session_id" }, 400);
    }
    if (Array.isArray(body["depends_on"])) {
      if (!body["depends_on"].every((d) => typeof d === "string")) {
        return c.json({ error: "depends_on must be string[]" }, 400);
      }
      patch.depends_on = body["depends_on"] as string[];
    }
    if (Object.prototype.hasOwnProperty.call(body, "start_at")) {
      const v = body["start_at"];
      if (v !== null && typeof v !== "string") {
        return c.json({ error: "invalid start_at" }, 400);
      }
      patch.start_at = v as string | null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "due_at")) {
      const v = body["due_at"];
      if (v !== null && typeof v !== "string") {
        return c.json({ error: "invalid due_at" }, 400);
      }
      patch.due_at = v as string | null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "recurrence")) {
      const v = body["recurrence"];
      if (v !== null && (typeof v !== "object" || Array.isArray(v))) {
        return c.json({ error: "invalid recurrence" }, 400);
      }
      patch.recurrence = v as Parameters<
        typeof manager.taskStore.update
      >[1]["recurrence"];
    }

    try {
      const task = await manager.taskStore.update(id, patch);
      return c.json({ task });
    } catch (e) {
      if (e instanceof TaskStoreError) {
        return c.json(
          { error: e.code, message: e.message },
          statusErrorCode(e.code) as 400 | 404 | 409
        );
      }
      throw e;
    }
  });

  // DELETE /api/tasks/:id?force=true
  app.delete("/api/tasks/:id", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const url = new URL(c.req.url);
    const force = url.searchParams.get("force") === "true";
    try {
      await manager.taskStore.delete(id, { force });
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof TaskStoreError) {
        return c.json(
          { error: e.code, message: e.message },
          statusErrorCode(e.code) as 400 | 404 | 409
        );
      }
      throw e;
    }
  });
}
