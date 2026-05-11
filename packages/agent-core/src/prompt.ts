/**
 * System prompt builder.
 *
 * The memory section is assembled in three parts when memory is enabled:
 *   1. Index header + truncated MEMORY.md content + warning if truncated
 *   2. Convention text (Claude Code's auto-memory rules, types dropped)
 *   3. Conditional cluttered-memory instruction (Anthropic's secondary
 *      mitigation — appended when entry-file count > 10 OR index >80% cap)
 *
 * The Anthropic `memory_20250818` "ALWAYS VIEW YOUR MEMORY DIRECTORY..."
 * protocol text lives ONLY in the memory tool's description (where the
 * Anthropic spec auto-injects it). Duplicating it in the system prompt
 * over-primed the agent — every turn started with "I'll check my memory
 * directory first as required by the protocol." Claude Code's own
 * `buildMemoryLines` doesn't include it either; convention is enough.
 */

import type { IndexSnapshot } from "@openacme/memory";
import { MEMORY_CONVENTION } from "./prompt-fragments/memory-convention.js";

// ── Memory injection caps (Claude Code `memdir/memdir.ts` lift) ────────

/** Index line cap at injection. Truncates with verbatim warning. */
export const MAX_ENTRYPOINT_LINES = 200;

/**
 * Index byte cap at injection. Catches long-line indexes that slip past
 * the line cap. Claude Code comment: `p100 observed: 197KB under 200 lines`.
 */
export const MAX_ENTRYPOINT_BYTES = 25_000;

/** Threshold for appending Anthropic's "keep your memory folder organized"
 * instruction — fires when there are more than this many entry files. */
const CLUTTERED_FILE_COUNT_THRESHOLD = 10;

/** Threshold for the same — fires when MEMORY.md is over this fraction
 * of its configured char cap. */
const CLUTTERED_FILL_FRACTION_THRESHOLD = 0.8;

/**
 * Anthropic's secondary mitigation, quoted verbatim from the memory-tool
 * docs. Appended only when the dir is starting to look cluttered — Anthropic
 * explicitly suggests this for the cluttered-memory case.
 */
const CLUTTERED_MEMORY_INSTRUCTION =
  "Note: when editing your memory folder, always try to keep its content " +
  "up-to-date, coherent and organized. You can rename or delete files that " +
  "are no longer relevant. Do not create new files unless necessary.";

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Truncate the index content to the line AND byte caps, appending a
 * verbatim warning that names which cap fired. Lifted from Claude Code
 * `memdir/memdir.ts:truncateEntrypointContent`.
 */
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

/**
 * Build the four-part `## Memory` section for the system prompt.
 * Always emits the protocol + convention when memory is enabled, even
 * if MEMORY.md is empty — so the agent knows the tool exists from
 * turn one.
 */
function buildMemorySection(snapshot: IndexSnapshot): string {
  const parts: string[] = [];

  // Part 1 — index (with header showing utilization and entry count)
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

  // Part 2 — convention text (Claude Code, types dropped). The
  // Anthropic protocol text lives in the memory tool's description
  // only; we used to duplicate it here and the agent over-narrated
  // ("I'll check my memory directory first as required by the
  // protocol") on every turn. Convention alone is sufficient.
  parts.push(MEMORY_CONVENTION);

  // Part 3 — conditional cluttered-memory instruction
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
  // give the agent live state mid-turn.
  if (options.tasksContext) {
    parts.push(`\n## Tasks\n${options.tasksContext}`);
  }

  // Platform-specific hints
  if (options.platformHints) {
    parts.push(`\n## Platform\n${options.platformHints}`);
  }

  return parts.join("\n\n");
}
