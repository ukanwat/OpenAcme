/**
 * Session title generator. One-shot structured subagent call producing
 * a 3-7 word topic title. Used by `Agent.fireTitle` from the chat-route
 * `onFinish`. Falls back to a slice of the assistant's first text on
 * non-completed status or empty output.
 */

import { z } from "zod";
import type { UIMessage } from "ai";
import { createLogger } from "@openacme/config/logger";
import { runSubagent } from "./subagent.js";
import type { Agent } from "./agent.js";

const log = createLogger("agent-core.title");

const TITLE_SYSTEM = [
  "Write a concise topic title for a chat conversation.",
  "Rules:",
  "- 3 to 7 words.",
  "- Plain text only: no quotes, no markdown, no trailing punctuation.",
  "- Title-case or sentence-case — whichever reads naturally.",
  '- Describe the topic, not the speaker ("OAuth refresh bug", not "User asks about OAuth").',
].join("\n");

const TitleSchema = z.object({ title: z.string().min(1).max(80) });

const MAX_INPUT_CHARS = 800;
const TITLE_TIMEOUT_MS = 15_000;
const TITLE_MAX_OUTPUT_TOKENS = 64;

export interface RunTitleArgs {
  parent: Agent;
  userText: string;
  assistantText: string;
  abortSignal?: AbortSignal;
}

export async function runTitle(args: RunTitleArgs): Promise<string | null> {
  const user = [
    "User:",
    truncate(args.userText, MAX_INPUT_CHARS) || "(empty)",
    "",
    "Assistant:",
    truncate(args.assistantText, MAX_INPUT_CHARS) || "(empty)",
  ].join("\n");

  const res = await runSubagent({
    mode: "structured",
    parent: args.parent,
    system: TITLE_SYSTEM,
    user,
    schema: TitleSchema,
    maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
    timeoutMs: TITLE_TIMEOUT_MS,
    abortSignal: args.abortSignal,
  });

  if (res.status !== "completed" || !res.object) {
    if (res.status === "failed") {
      log.warn(
        { agentId: args.parent.config.id, error: res.error ?? "unknown" },
        "title generation failed"
      );
    }
    return null;
  }
  return sanitizeTitle(res.object.title);
}

export function extractTitleInputs(messages: readonly UIMessage[]): {
  userText: string;
  assistantText: string;
} {
  return {
    userText: firstTextOfRole(messages, "user"),
    assistantText: firstTextOfRole(messages, "assistant"),
  };
}

/** Pre-LLM fallback: slice of the assistant's first text-part, ≤80 chars. */
export function sliceFallbackTitle(
  messages: readonly UIMessage[]
): string | null {
  const text = firstTextOfRole(messages, "assistant");
  if (!text) return null;
  const sliced = text.slice(0, 80).replace(/\n/g, " ").trim();
  return sliced || null;
}

function firstTextOfRole(
  messages: readonly UIMessage[],
  role: "user" | "assistant"
): string {
  for (const m of messages) {
    if (m.role !== role) continue;
    const text = m.parts
      .filter(
        (p): p is { type: "text"; text: string } =>
          (p as { type?: unknown }).type === "text"
      )
      .map((p) => p.text)
      .join(" ")
      .trim();
    if (text) return text;
  }
  return "";
}

function sanitizeTitle(s: string): string | null {
  const cleaned = s
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?\s]+$/, "")
    .trim();
  return cleaned.slice(0, 80) || null;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

export const __test = { sanitizeTitle, firstTextOfRole };
