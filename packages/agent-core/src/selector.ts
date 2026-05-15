/**
 * Memory recall selector — verbatim port of Claude Code
 * `memdir/findRelevantMemories.ts`. Given the work-item that brought
 * the agent into this turn, scans `<agentDir>/memory/` for entry files,
 * asks a side-query model to pick up to 5 relevant ones by name, and
 * returns the chosen paths.
 *
 * Implementation note: routes through `runSubagent({mode:"structured"})`
 * — the unified subagent primitive in `subagent.ts`. The `structured`
 * mode is a one-shot side query with a custom system prompt and a JSON
 * schema; it does NOT inherit the parent's prompt or tools (which is
 * the right shape for "pick filenames from this manifest"). The
 * extractor uses the SAME primitive's `forked` mode, since extraction
 * needs the memory tool and may take multiple turns. Different specs,
 * one entry point — see `subagent.ts`.
 *
 * Cross-provider behavior: structured mode uses `generateObject`
 * internally, which uses provider-native structured output where
 * available (Anthropic tool-call mode, OpenAI structured outputs,
 * Google JSON schema, OpenRouter pass-through). For providers/models
 * that don't support it (small Ollama models, some custom endpoints),
 * the call fails → `runSubagent` returns `status: "failed"` → we
 * return `[]` and recall silently no-ops. Acceptable degradation;
 * the agent still works, just without recall.
 *
 * Design notes (see plan §G):
 * - Trigger source is opaque: the selector reads `triggerText`, not
 *   "the user's message." Same code runs whether a user message, a
 *   task payload, a peer message, or a cron tick brought the agent in.
 * - `alreadySurfaced` is filtered before the model call so the 5-slot
 *   budget isn't spent on entries the caller will discard anyway.
 * - `recentTools` suppresses tool-reference-doc hits when the agent
 *   is actively exercising those tools (the conversation already
 *   contains working usage). Verbatim from Claude Code's prompt.
 * - Empty memory dir → returns `[]` cheaply with no model call.
 *
 * Today the selector uses the agent's main model (via `parent.config.model`).
 * The "use a cheap Sonnet for the side query" optimization in Claude
 * Code maps cleanly to a future per-agent `selectorModel` config; out
 * of scope for Phase 2 ship.
 */

import { z } from "zod";
import {
  formatMemoryManifest,
  scanMemoryFiles,
  type MemoryHeader,
} from "@openacme/memory";
import type { Agent } from "./agent.js";
import { runSubagent } from "./subagent.js";

export interface RelevantMemory {
  path: string;
  mtimeMs: number;
}

const MAX_SELECTED = 5;
const SELECTOR_TIMEOUT_MS = 30_000;
const SELECTOR_MAX_OUTPUT_TOKENS = 256;

/**
 * Verbatim from Claude Code. Models trained on this exact wording
 * recognize the contract — paraphrasing loses the trained behavior
 * (matches the same rationale we used for the memory tool description).
 */
const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to the assistant as it processes a query. You will be given the query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to the assistant as it processes the query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (the assistant is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`;

const SelectionSchema = z.object({
  selected_memories: z.array(z.string()),
});

export interface FindRelevantMemoriesArgs {
  /** Parent agent — provides the model for the structured call. */
  parent: Agent;
  /** The work-item description that triggered this activation. Opaque
   *  to source — could be a user message, task payload, peer message,
   *  or cron tick body. */
  triggerText: string;
  /** Absolute filesystem path to `<agentDir>/memory/`. */
  memoryDir: string;
  /** Tool names the agent has actually invoked recently — used to
   *  suppress tool-reference-doc hits. Empty list = no suppression. */
  recentTools?: readonly string[];
  /** Paths already surfaced earlier in this session; skipped before
   *  the model call so the budget goes to fresh candidates. */
  alreadySurfaced?: ReadonlySet<string>;
  signal?: AbortSignal;
}

export async function findRelevantMemories(
  args: FindRelevantMemoriesArgs
): Promise<RelevantMemory[]> {
  const surfaced = args.alreadySurfaced ?? new Set<string>();
  const all = await scanMemoryFiles(args.memoryDir, args.signal);
  const candidates = all.filter((m) => !surfaced.has(m.filePath));
  if (candidates.length === 0) return [];

  const selectedNames = await selectFilenames(candidates, args);
  const byName = new Map(candidates.map((m) => [m.filename, m]));
  const out: RelevantMemory[] = [];
  for (const name of selectedNames) {
    const hit = byName.get(name);
    if (hit) out.push({ path: hit.filePath, mtimeMs: hit.mtimeMs });
    if (out.length >= MAX_SELECTED) break;
  }
  return out;
}

async function selectFilenames(
  candidates: MemoryHeader[],
  args: FindRelevantMemoriesArgs
): Promise<string[]> {
  const validNames = new Set(candidates.map((m) => m.filename));
  const manifest = formatMemoryManifest(candidates);
  const toolsSection =
    args.recentTools && args.recentTools.length > 0
      ? `\n\nRecently used tools: ${args.recentTools.join(", ")}`
      : "";
  const userMessage = `Query: ${args.triggerText}\n\nAvailable memories:\n${manifest}${toolsSection}`;

  const result = await runSubagent({
    mode: "structured",
    parent: args.parent,
    system: SELECT_MEMORIES_SYSTEM_PROMPT,
    user: userMessage,
    schema: SelectionSchema,
    maxOutputTokens: SELECTOR_MAX_OUTPUT_TOKENS,
    timeoutMs: SELECTOR_TIMEOUT_MS,
    abortSignal: args.signal,
  });

  if (result.status !== "completed" || !result.object) {
    if (result.status === "failed") {
      console.warn(
        `[memory.selector] agent=${args.parent.config.id}: ${result.error ?? "unknown"}`
      );
    }
    return [];
  }
  return result.object.selected_memories.filter((n) => validNames.has(n));
}
