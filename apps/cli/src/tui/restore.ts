import { randomUUID } from "node:crypto";
import type { Message as DbMessage } from "@openacme/db";
import { renderMarkdown } from "./markdown.js";
import type { AssistantPart, Message as TuiMessage } from "./state.js";

/**
 * Convert persisted DB rows into the TUI's message shape used to populate
 * `committed` when the user resumes an existing session via `/sessions`.
 *
 * Rebuilds an ordered `parts` array per assistant turn so text segments
 * between tool calls render in the same order they streamed live.
 * Persistence in `agent-core` writes one DB assistant row per step (with
 * step-text and toolCalls JSON) followed by one tool row per result, so
 * walking rows linearly preserves text → tool → text → tool ordering
 * across multi-step turns.
 *
 * `system` rows are skipped (no TUI representation). Orphan tool rows
 * (no matching call in the current accumulator) are skipped.
 */
export function dbMessagesToTuiMessages(rows: DbMessage[]): TuiMessage[] {
  const out: TuiMessage[] = [];
  let asstParts: AssistantPart[] = [];

  const flushAssistant = () => {
    if (asstParts.length === 0) return;
    const finalized = asstParts.map<AssistantPart>((p) =>
      p.kind === "text" && p.rendered === undefined
        ? { ...p, rendered: p.text ? renderMarkdown(p.text) : "" }
        : p
    );
    out.push({
      id: randomUUID(),
      role: "assistant",
      text: "",
      parts: finalized,
      finalized: true,
    });
    asstParts = [];
  };

  for (const row of rows) {
    if (row.role === "system") continue;

    if (row.role === "user") {
      flushAssistant();
      out.push({
        id: row.id || randomUUID(),
        role: "user",
        text: row.content ?? "",
        parts: [],
        finalized: true,
      });
      continue;
    }

    if (row.role === "assistant") {
      if (row.content) {
        asstParts.push({ kind: "text", text: row.content });
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
            asstParts.push({
              kind: "tool",
              toolCallId,
              name,
              args: e.args,
              status: "pending",
            });
          }
        }
      }
      continue;
    }

    if (row.role === "tool") {
      if (!row.toolCallId) continue;
      const target = asstParts.find(
        (p): p is Extract<AssistantPart, { kind: "tool" }> =>
          p.kind === "tool" && p.toolCallId === row.toolCallId
      );
      if (!target) continue;
      target.result = row.content ?? "";
      target.status = "done";
    }
  }

  flushAssistant();
  return out;
}
