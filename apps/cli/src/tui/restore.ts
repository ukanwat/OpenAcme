import { randomUUID } from "node:crypto";
import type { Message as DbMessage } from "@openacme/db";
import { renderMarkdown } from "./markdown.js";
import type { Message as TuiMessage, ToolEvent } from "./state.js";

/**
 * Convert persisted DB rows into the TUI's message shape used to populate
 * `committed` when the user resumes an existing session via `/sessions`.
 *
 * Group-by-user-boundary: a single user turn produces ONE assistant bubble
 * during live streaming (the reducer in `state.ts` accumulates all
 * text-deltas, tool-calls, and tool-results into one inflight message).
 * Persistence in `agent-core` writes one DB assistant row per step plus
 * one DB tool row per result, so a multi-step turn fans out to many rows.
 * To keep restored history visually identical to the live render we walk
 * rows linearly between user-row boundaries and fold the assistant rows +
 * tool rows back into one TUI assistant message per turn.
 *
 * `system` rows are skipped (no TUI representation). Orphan tool rows
 * (no matching call in the current accumulator) are skipped — `agent.ts`
 * `buildCoreMessages` already drops these on the way out, so they're rare.
 */
export function dbMessagesToTuiMessages(rows: DbMessage[]): TuiMessage[] {
  const out: TuiMessage[] = [];

  let asstText = "";
  let asstTools: ToolEvent[] = [];
  let asstHasContent = false;

  const flushAssistant = () => {
    if (!asstHasContent) return;
    const text = asstText;
    out.push({
      id: randomUUID(),
      role: "assistant",
      text,
      rendered: text ? renderMarkdown(text) : "",
      tools: asstTools,
      finalized: true,
    });
    asstText = "";
    asstTools = [];
    asstHasContent = false;
  };

  for (const row of rows) {
    if (row.role === "system") continue;

    if (row.role === "user") {
      flushAssistant();
      out.push({
        id: row.id || randomUUID(),
        role: "user",
        text: row.content ?? "",
        tools: [],
        finalized: true,
      });
      continue;
    }

    if (row.role === "assistant") {
      if (row.content) {
        asstText = asstText
          ? `${asstText}\n\n${row.content}`
          : row.content;
        asstHasContent = true;
      }
      if (row.toolCalls) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.toolCalls);
        } catch {
          parsed = null;
        }
        if (Array.isArray(parsed)) {
          for (const c of parsed) {
            if (!c || typeof c !== "object") continue;
            const e = c as {
              toolCallId?: string;
              id?: string;
              toolName?: string;
              name?: string;
              args?: unknown;
            };
            const toolCallId = e.toolCallId ?? e.id ?? "";
            const name = e.toolName ?? e.name ?? "";
            if (!toolCallId || !name) continue;
            asstTools.push({
              toolCallId,
              name,
              args: e.args,
              status: "done",
            });
            asstHasContent = true;
          }
        }
      }
      continue;
    }

    if (row.role === "tool") {
      if (!row.toolCallId) continue;
      const target = asstTools.find((t) => t.toolCallId === row.toolCallId);
      if (!target) continue; // orphan
      target.result = row.content ?? "";
      target.status = "done";
    }
  }

  flushAssistant();
  return out;
}
