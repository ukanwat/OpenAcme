/**
 * Memory extraction subagent — Phase 3 (see plan §H). Port of Claude
 * Code `services/extractMemories/extractMemories.ts`, adapted to drop
 * the type taxonomy (matches Phase 1's convention).
 *
 * Triggered post-turn (after `streamText` completes). Two paths in
 * parallel by design:
 *   1. Main agent writes during the turn (primary; convention text
 *      taught in the system prompt).
 *   2. Extractor reads the just-completed transcript and writes
 *      anything the main agent missed (safety net).
 *
 * Skip-when-main-agent-wrote: scan the just-completed turn for any
 * `tool-memory` parts whose input has `command ∈ {create, str_replace,
 * insert}`. If present, the main agent did the job; skip the fork.
 *
 * Failure-tolerant — extractor failure must NOT fail the parent
 * activation. Caller fires with `void` and ignores the promise.
 *
 * Trigger source is opaque: runs at end of every successful agent
 * activation regardless of what brought the agent in (user message,
 * task wakeup, peer message, cron tick).
 */

import { stepCountIs } from "ai";
import type { UIMessage } from "ai";
import {
  formatMemoryManifest,
  scanMemoryFiles,
} from "@openacme/memory";
import type { Agent } from "./agent.js";
import { runSubagent, type ForkedSubagentResult } from "./subagent.js";

const EXTRACTOR_STEP_CAP = 10;
const EXTRACTOR_TIMEOUT_MS = 120_000;
const EXTRACTOR_TOOLS = new Set(["memory"]);

export type ExtractorStatus =
  | "skipped-main-wrote"
  | "skipped-no-new-content"
  | "completed"
  | "timeout"
  | "aborted"
  | "failed";

export interface ExtractorResult {
  status: ExtractorStatus;
  /** Wrapped result from the underlying fork when it ran. */
  fork?: ForkedSubagentResult;
  error?: string;
}

export interface RunExtractorArgs {
  agent: Agent;
  /** Session id whose just-completed turn drives extraction. */
  sessionId: string;
  /** Full message history including the latest assistant turn. */
  sessionMessages: readonly UIMessage[];
  /** New-message count since the last extraction cursor. The cursor
   *  itself is owned by the caller (e.g. server route holding a Map
   *  per-session). Pass the full list size if no cursor exists. */
  newMessageCount: number;
  abortSignal?: AbortSignal;
}

/**
 * Returns true if any assistant message in `messages` contains a
 * `tool-memory` part whose input was a write op (`create`,
 * `str_replace`, `insert`). Read-only commands (`view`, `delete`,
 * `rename`) don't count — the cue we want is "did the main agent put
 * a fact into memory."
 */
export function hasMemoryWritesIn(
  messages: readonly UIMessage[]
): boolean {
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.parts)) continue;
    for (const part of m.parts) {
      const p = part as { type?: unknown; input?: unknown; state?: unknown };
      if (typeof p.type !== "string") continue;
      if (p.type !== "tool-memory") continue;
      // Only count parts the SDK marks as having actually run; in-flight
      // (input-streaming/input-available) ones are speculative until the
      // result lands.
      if (p.state !== "input-available" && p.state !== "output-available") {
        continue;
      }
      const input = p.input as { command?: unknown } | undefined;
      const cmd = input?.command;
      if (cmd === "create" || cmd === "str_replace" || cmd === "insert") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build the extraction prompt. Adapted from Claude Code's
 * `buildExtractAutoOnlyPrompt`, with the type taxonomy stripped (the
 * Phase-1 convention has no `type` field in the frontmatter).
 *
 * The manifest is pre-injected so the fork doesn't burn a turn on
 * `view /memories` to learn what's already there.
 */
function buildExtractionPrompt(
  newMessageCount: number,
  existingManifest: string
): string {
  const manifestBlock =
    existingManifest.length > 0
      ? `\n\n## Existing memory files\n\n${existingManifest}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
      : "";
  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${newMessageCount} messages above and use them to update your persistent memory directory.`,
    "",
    "Available tool: `memory` (your standard six-op directory tool — `view`, `create`, `str_replace`, `insert`, `delete`, `rename`). The full memory protocol and convention from your system prompt apply: write durable facts as their own entry files with `name` + `description` frontmatter, and add a one-line pointer to `MEMORY.md`.",
    "",
    "You have a limited turn budget. The efficient strategy is: turn 1 — `view` the entries you might update (in parallel where the schema allows); turn 2 — `create` / `str_replace` for the writes. Do not interleave reads and writes across multiple turns.",
    "",
    "Use ONLY content from the recent messages above. Do not investigate further — no shell commands, no grepping source files, no verifying against current state. The job is extraction, not research.",
    "",
    "Save criteria — what to extract:",
    "- Durable facts about the user, the project, or recurring constraints.",
    "- Feedback the user gave (corrections OR confirmations of non-obvious choices).",
    "- Decisions whose rationale wouldn't be obvious from code / git history alone.",
    "- Pointers to where information lives in external systems.",
    "",
    "Save each as its own file with `name` + `description` frontmatter and a body that leads with the point, then `**Why:**` and `**How to apply:**` lines (see your system prompt for the convention). Add a one-line pointer to `MEMORY.md` after each new entry.",
    "",
    "What NOT to save:",
    "- Code patterns, architecture, file paths — re-derivable from the codebase.",
    "- Git history, recent changes, who-changed-what.",
    "- Debugging solutions — the fix is in the code; the commit message has context.",
    "- Ephemeral task state and current conversation context.",
    "",
    "If nothing in the recent messages is worth saving, do nothing and stop. Saving is opt-in; silence is a valid response.",
    manifestBlock,
  ].join("\n");
}

export async function runExtractor(
  args: RunExtractorArgs
): Promise<ExtractorResult> {
  if (args.newMessageCount <= 0) {
    return { status: "skipped-no-new-content" };
  }

  // Mutual exclusion with the main agent: when the main agent already
  // wrote to memory during this turn, the fork is redundant. Skip and
  // let the cursor (caller-owned) advance past this range so we don't
  // re-evaluate next turn either.
  if (hasMemoryWritesIn(args.sessionMessages)) {
    return { status: "skipped-main-wrote" };
  }

  let manifest = "";
  try {
    const memoryDir = args.agent.memoryStore.dirPath(args.agent.config.id);
    const headers = await scanMemoryFiles(memoryDir, args.abortSignal);
    manifest = formatMemoryManifest(headers);
  } catch {
    // Scan failure is recoverable — fall through with an empty manifest;
    // the fork will just call `view /memories` if it wants the listing.
  }

  const prompt = buildExtractionPrompt(args.newMessageCount, manifest);

  let fork: ForkedSubagentResult;
  try {
    fork = await runSubagent({
      mode: "forked",
      parent: args.agent,
      parentSessionId: args.sessionId,
      // Fork sees the parent's full session history with the extractor
      // prompt appended. Without this the prompt's "analyze the
      // messages above" refers to nothing — the fork would have no
      // conversation to extract from. Identical context across turns
      // shares the prompt cache; only the seed prompt is new.
      contextMessages: args.sessionMessages,
      initialMessage: prompt,
      stopWhen: stepCountIs(EXTRACTOR_STEP_CAP),
      timeoutMs: EXTRACTOR_TIMEOUT_MS,
      abortSignal: args.abortSignal,
      // Restrict to memory only — the fork is fire-and-forget and
      // unsupervised; allowing shell/edit/web on background work is a
      // cost+safety hazard. The system prompt still says all tools
      // exist (it's the parent's), but unavailable tools just produce
      // a "tool not available" recovery — minor confusion, no breakage.
      toolFilter: EXTRACTOR_TOOLS,
      telemetryFunctionId: `${args.agent.config.id}:subagent.forked.extractor`,
    });
  } catch (e) {
    return {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  return { status: fork.status, fork };
}

export const __test = { buildExtractionPrompt };
