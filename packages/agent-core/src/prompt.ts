/**
 * System prompt builder — assembles the system prompt from persona, skills, tools.
 * Mirrors Hermes agent/prompt_builder.py.
 */

/**
 * Memory tool behavioral guidance. Ported verbatim from Hermes
 * `agent/prompt_builder.py:150-168` (`MEMORY_GUIDANCE`). Only injected when the
 * `memory` tool is available — otherwise it's noise.
 *
 * The declarative-vs-imperative paragraph is the load-bearing part: without
 * it, models save entries like "Always use Pino" which get re-read as
 * directives in every future session.
 */
const MEMORY_GUIDANCE =
  "You have persistent memory across sessions. Save durable facts using the memory " +
  "tool: user preferences, environment details, tool quirks, and stable conventions. " +
  "Memory is injected into every turn, so keep it compact and focused on facts that " +
  "will still matter later.\n" +
  "Prioritize what reduces future user steering — the most valuable memory is one " +
  "that prevents the user from having to correct or remind you again. " +
  "User preferences and recurring corrections matter more than procedural task details.\n" +
  "Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO " +
  "state to memory; use session_search to recall those from past transcripts. " +
  "If you've discovered a new way to do something, solved a problem that could be " +
  "necessary later, save it as a skill with the skill tool.\n" +
  "Write memories as declarative facts, not instructions to yourself. " +
  "'User prefers concise responses' ✓ — 'Always respond concisely' ✗. " +
  "'Project uses pytest with xdist' ✓ — 'Run tests with pytest -n 4' ✗. " +
  "Imperative phrasing gets re-read as a directive in later sessions and can " +
  "cause repeated work or override the user's current request. Procedures and " +
  "workflows belong in skills, not memory.";

/**
 * Behavioral guidance for the task tools. Injected when `task_create` is
 * available so the agent knows when to file tasks vs. just do the work,
 * how the queue / scheduler will pick them up, and the surprising
 * recurring-done semantic (done → open self-reset).
 */
const TASKS_GUIDANCE =
  "Tasks are persistent units of work backed by markdown files. The scheduler runs " +
  "them autonomously: when a task's start_at arrives or a queue slot opens, the " +
  "assignee agent runs a turn for it without further user input.\n" +
  "File a task when: the work spans multiple turns or sessions, has a future start " +
  "time, needs to wait on another task (depends_on), or should be handed to a " +
  "different agent. Don't file a task for something you can finish in the current " +
  "turn — just do it.\n" +
  "Each task binds to a session. By default, a fresh session is lazily created when " +
  "the scheduler activates the task — clean isolation. Pass `sameSession: true` to " +
  "queue the task in YOUR current session (only honored when you're also the " +
  "assignee). Per-session, at most one task is in_progress at a time; the rest " +
  "queue in created_at order.\n" +
  "Cross-agent: passing a different `assignee` files work for that agent. They'll " +
  "pick it up autonomously in a fresh session — you don't message them directly.\n" +
  "Recurring tasks: pass `recurrence` (cron or interval). When you mark a recurring " +
  "task `done`, the store self-resets it to `open` with the next fire time — the " +
  "returned status is `open`, not `done`, and `runs` increments. This is intentional. " +
  "Use `status: \"canceled\"` to stop the recurrence permanently. Choose " +
  "`recurrence.session: \"reuse\"` for an ongoing thread (context accumulates), " +
  "`\"fresh\"` (default) for clean isolation each fire.\n" +
  "Status discipline: flip to `in_progress` when you start, `done` when finished, " +
  "`blocked` if you can't proceed (the scheduler also flips to blocked on errors / " +
  "timeouts; that stops a failing recurring task from looping). Append progress notes " +
  "to the body — pass the FULL replacement body, not a diff.\n" +
  "Use `task_list` for the live queue and `task_view` to read a task's full body " +
  "before starting work — the system-prompt snapshot is from session start and may " +
  "be stale.";

export function buildSystemPrompt(options: {
  persona: string;
  toolNames: string[];
  skillsIndex?: string;
  tasksContext?: string;
  memoryContext?: string;
  platformHints?: string;
}): string {
  const parts: string[] = [];

  // Identity / persona
  parts.push(options.persona);

  // Tool usage guidance
  if (options.toolNames.length > 0) {
    parts.push(
      `\n## Available Tools\nYou have access to the following tools: ${options.toolNames.join(", ")}.\n` +
        `Use tools proactively to gather information and complete tasks. ` +
        `When a task requires multiple steps, use tools sequentially until complete.`
    );
  }

  // Memory tool guidance — gated on the tool being available, mirrors
  // Hermes `run_agent.py:4874`. This stays in the prompt even when MEMORY.md
  // is empty so the agent knows the tool exists and what to save into it.
  if (options.toolNames.includes("memory")) {
    parts.push(`\n## Memory tool\n${MEMORY_GUIDANCE}`);
  }

  // Tasks behavioral guidance — gated on `task_create` so the agent
  // doesn't see this when tasks aren't enabled. Stays in the prompt
  // regardless of whether any tasks currently exist.
  if (options.toolNames.includes("task_create")) {
    parts.push(`\n## Tasks tool\n${TASKS_GUIDANCE}`);
  }

  // Skills index (Level 0 — names + descriptions). Bodies aren't loaded
  // until the agent calls `skill_view` for one that applies.
  if (options.skillsIndex) {
    parts.push(
      `\n## Skills\nYou have the following skills available. Each entry is name + short description; ` +
        `call \`skill_view\` with the name to load the full instructions when one applies.\n${options.skillsIndex}`
    );
  }

  // Tasks snapshot — what's assigned to / created by this agent in this
  // session. Built once at session start; tools (`task_list`, `task_view`)
  // give the agent live state mid-turn.
  if (options.tasksContext) {
    parts.push(`\n## Tasks\n${options.tasksContext}`);
  }

  // Memory context (rendered MEMORY.md block — header + entries).
  // Empty when MEMORY.md is empty; skipped here so a fresh agent doesn't
  // see an empty section.
  if (options.memoryContext) {
    parts.push(`\n## Memory\n${options.memoryContext}`);
  }

  // Platform-specific hints
  if (options.platformHints) {
    parts.push(`\n## Platform\n${options.platformHints}`);
  }

  return parts.join("\n\n");
}
