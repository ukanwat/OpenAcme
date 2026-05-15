/**
 * System prompt builder. Memory section: index + convention + conditional
 * "keep organized" instruction. The Anthropic memory_20250818 protocol
 * preamble is left to the tool description (duplicating it over-primed
 * the agent into narrating "checking memory first" every turn).
 */

import type { IndexSnapshot } from "@openacme/memory";
import { MEMORY_CONVENTION } from "./prompt-fragments/memory-convention.js";

// Memory-index injection caps (CC `memdir/memdir.ts` lift). Byte cap
// catches long-line indexes that slip past the line cap.
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;

// Cluttered-memory thresholds. Triggers appending Anthropic's "keep
// organized" instruction.
const CLUTTERED_FILE_COUNT_THRESHOLD = 10;
const CLUTTERED_FILL_FRACTION_THRESHOLD = 0.8;

// Verbatim from Anthropic memory-tool docs.
const CLUTTERED_MEMORY_INSTRUCTION =
  "Note: when editing your memory folder, always try to keep its content " +
  "up-to-date, coherent and organized. You can rename or delete files that " +
  "are no longer relevant. Do not create new files unless necessary.";

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// CC `memdir/memdir.ts:truncateEntrypointContent` lift.
function truncateIndex(raw: string): {
  content: string;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
} {
  const trimmed = raw.trim();
  const contentLines = trimmed.split("\n");
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, wasLineTruncated, wasByteTruncated };
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n")
    : trimmed;

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatBytes(byteCount)} (limit: ${formatBytes(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatBytes(byteCount)}`;

  return {
    content:
      truncated +
      `\n\n> WARNING: MEMORY.md is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    wasLineTruncated,
    wasByteTruncated,
  };
}

// Always emits even when MEMORY.md is empty so the agent knows the tool exists.
function buildMemorySection(snapshot: IndexSnapshot): string {
  const parts: string[] = [];

  const used = snapshot.used;
  const limit = snapshot.limit;
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const entryWord = snapshot.entryCount === 1 ? "entry" : "entries";
  const header = `══════════════════════════════════════════════
MEMORY [${pct}% — ${used}/${limit} chars] · ${snapshot.entryCount} ${entryWord}
══════════════════════════════════════════════`;
  if (snapshot.content.length > 0) {
    const truncated = truncateIndex(snapshot.content);
    parts.push(`${header}\n${truncated.content}`);
  } else {
    parts.push(`${header}\n(empty — no memories yet)`);
  }

  parts.push(MEMORY_CONVENTION);

  const fillFraction = limit > 0 ? used / limit : 0;
  const isCluttered =
    snapshot.entryCount > CLUTTERED_FILE_COUNT_THRESHOLD ||
    fillFraction > CLUTTERED_FILL_FRACTION_THRESHOLD;
  if (isCluttered) {
    parts.push(CLUTTERED_MEMORY_INSTRUCTION);
  }

  return parts.join("\n\n");
}

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
  "Each task binds to a session. The `session` field on `task_create` controls where " +
  "the work lives: `\"current\"` (only when self-assigning) puts the task in your " +
  "current session; `\"fresh\"` requests a brand-new session the scheduler allocates " +
  "when ready; omit for the smart default (current when self-assigning, fresh " +
  "otherwise). If you intend to work on a task RIGHT NOW in this same turn, use " +
  "`\"current\"` — otherwise a parallel session can wake and race you. Per-session, " +
  "at most one task is in_progress at a time; the rest queue in created_at order.\n" +
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
  memorySnapshot?: IndexSnapshot;
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

  // Memory section — emitted whenever the agent has the memory tool
  // (presence of memorySnapshot from the caller signals this). Always
  // includes protocol + convention; index is empty-formatted when there
  // are no entries yet.
  if (options.toolNames.includes("memory") && options.memorySnapshot) {
    parts.push(`\n## Memory\n${buildMemorySection(options.memorySnapshot)}`);
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
  // give the agent live state mid-turn. Recent activity (event feed) is
  // NOT in the system prompt — runAutonomous appends it to the user
  // message instead so it stays per-turn fresh and doesn't get cached.
  if (options.tasksContext) {
    parts.push(`\n## Tasks\n${options.tasksContext}`);
  }

  // Platform-specific hints
  if (options.platformHints) {
    parts.push(`\n## Platform\n${options.platformHints}`);
  }

  return parts.join("\n\n");
}
