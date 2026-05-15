import * as fs from "node:fs";
import * as path from "node:path";
import {
  convertToModelMessages,
  type UIMessage,
  type ModelMessage,
  type ToolSet,
} from "ai";

/**
 * Local URL contract: `/api/attachments/<sessionId>/<attachmentId>/<filename>`.
 * The path round-trips to a relative path under <dataDir>/attachments — no
 * sidecar table required to look up where on disk an attachment lives.
 */
const ATTACHMENT_URL_RE = /^\/api\/attachments\/([^/]+)\/([^/]+)\/(.+)$/;

/** Parse an `/api/attachments/<...>` URL into a relative path under the
 *  attachments root. Returns null for any other URL shape (`data:`, http,
 *  etc) so callers know to pass through. */
export function parseAttachmentUrl(url: string): string | null {
  const m = url.match(ATTACHMENT_URL_RE);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

/**
 * Most providers can't reach `127.0.0.1` URLs, so before handing
 * UIMessages to `convertToModelMessages` we walk every FileUIPart whose
 * URL is one of ours and inline the bytes as a `data:` URL.
 *
 * Other URLs (already-data, external https) pass through unchanged.
 * Missing files yield a placeholder text part — the message still sends
 * but the model sees a clear marker instead of broken bytes.
 */
export function inlineFileAttachments(
  messages: UIMessage[],
  attachmentsRoot: string
): UIMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => {
      if (p.type !== "file") return p;
      const rel = parseAttachmentUrl(p.url);
      if (!rel) return p;
      const abs = path.join(attachmentsRoot, rel);
      try {
        const bytes = fs.readFileSync(abs);
        return {
          ...p,
          url: `data:${p.mediaType};base64,${bytes.toString("base64")}`,
        };
      } catch {
        return {
          type: "text" as const,
          text: `[attachment unavailable: ${p.filename ?? rel}]`,
        };
      }
    }),
  }));
}

/**
 * A `tool-${name}` part stuck in `input-streaming` or `input-available`
 * is an aborted tool call — model emitted the call but the result never
 * arrived (user hit Stop, request timed out, etc). Sending it to the
 * provider unchanged trips the tool_use/tool_result pairing check.
 *
 * Rewrite it to `output-error` so `convertToModelMessages` emits the
 * matching tool-result with an interrupt marker the model can see.
 */
const INTERRUPT_MARKER = "[interrupted]";
export function finalizeOrphanToolParts(
  parts: UIMessage["parts"]
): UIMessage["parts"] {
  return parts.map((p) => {
    const tp = p as { type?: string; state?: string };
    if (!tp.type?.startsWith("tool-")) return p;
    if (tp.state !== "input-streaming" && tp.state !== "input-available") return p;
    return {
      ...(p as object),
      state: "output-error",
      errorText: INTERRUPT_MARKER,
    } as UIMessage["parts"][number];
  });
}

/**
 * Inject `step-start` parts before any text that follows a tool part
 * without one already present. `convertToModelMessages` uses
 * `step-start` as the split marker; without it, an assistant message
 * shaped `[text, tool, text]` collapses into a single model assistant
 * message and Anthropic rejects with "tool_use ... without tool_result
 * blocks immediately after" because the post-tool text means the model
 * "continued without waiting."
 *
 * Idempotent: pre-existing step-start parts are preserved and reset
 * the "needs boundary" flag.
 */
export function ensureStepBoundaries(
  parts: UIMessage["parts"]
): UIMessage["parts"] {
  const out: UIMessage["parts"] = [];
  let unbalancedTool = false;
  for (const p of parts) {
    const tp = p as { type?: string };
    if (tp.type === "step-start") {
      out.push(p);
      unbalancedTool = false;
      continue;
    }
    if (tp.type === "text" && unbalancedTool) {
      out.push({ type: "step-start" } as UIMessage["parts"][number]);
      unbalancedTool = false;
    }
    out.push(p);
    if (tp.type?.startsWith("tool-")) {
      unbalancedTool = true;
    }
  }
  return out;
}

/**
 * Apply `finalizeOrphanToolParts` + `ensureStepBoundaries` to each
 * message in a stored-history list. Handles legacy DB rows (process
 * crashed mid-tool, abort path that pre-dated this fix, CLI assembly
 * path that pre-dated step-start support, etc.) so the rendered +
 * replayed view is always pair-consistent without mutating disk.
 *
 * Generic over the row shape so callers don't have to widen their
 * `StoredUIMessage` to a full `UIMessage`.
 */
export function sanitizeStoredHistory<M extends { parts: unknown[] }>(
  messages: M[]
): M[] {
  return messages.map((m) => ({
    ...m,
    parts: ensureStepBoundaries(
      finalizeOrphanToolParts(m.parts as UIMessage["parts"])
    ) as unknown[],
  }));
}

/**
 * For each user UIMessage carrying a `data-relevant-memory` part,
 * prepend its `modelContent` as a leading text part. The SDK strips
 * `data-*` parts in `convertToModelMessages`, so without this
 * materialization the recall would never reach the model.
 *
 * Why persist + rematerialize instead of injecting once per turn: the
 * pre-rendered modelContent (with freshness "N days ago" baked in at
 * recall time) is byte-stable across turns. Injecting fresh per turn
 * would change those bytes (Date.now() shifts the days delta) and
 * invalidate the prefix cache from the user message onward.
 *
 * Note: the data-relevant-memory part itself stays on the message (we
 * only strip it from the model-input view here — DB storage + UI chip
 * keep the part). Multiple parts on one message (rare — defensive)
 * concatenate in order.
 */
function materializeRecallContext(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.parts)) return m;
    const recallTexts: string[] = [];
    const otherParts: UIMessage["parts"] = [];
    for (const p of m.parts) {
      if ((p as { type?: unknown }).type === "data-relevant-memory") {
        const content = (p as { data?: { modelContent?: unknown } }).data
          ?.modelContent;
        if (typeof content === "string" && content.length > 0) {
          recallTexts.push(content);
        }
        // Drop the data-* part from the model-input view (SDK would
        // strip it anyway). The original message in the caller's array
        // is untouched (we mapped to a new object).
      } else {
        otherParts.push(p);
      }
    }
    if (recallTexts.length === 0) return m;
    const leadingText = {
      type: "text" as const,
      text: recallTexts.join("\n\n"),
    } as UIMessage["parts"][number];
    return { ...m, parts: [leadingText, ...otherParts] };
  });
}

/**
 * Convert persisted UIMessages to ModelMessages ready for streamText.
 * Materializes recall-context, inlines local-attachment bytes, finalizes
 * any orphan tool parts, then defers to the SDK's own converter for
 * tool-${name} / text / file mapping.
 */
export async function uiToModelMessages(
  messages: UIMessage[],
  opts: { attachmentsRoot: string; tools?: ToolSet }
): Promise<ModelMessage[]> {
  const withRecall = materializeRecallContext(messages);
  const inlined = inlineFileAttachments(withRecall, opts.attachmentsRoot);
  const sanitized = inlined.map((m) => ({
    ...m,
    parts: ensureStepBoundaries(finalizeOrphanToolParts(m.parts)),
  }));
  return convertToModelMessages(sanitized, { tools: opts.tools });
}

export const __test = { materializeRecallContext };
