import {
  generateText,
  readUIMessageStream,
  streamText,
  stepCountIs,
  type ToolSet,
  type UIMessage,
  type StreamTextResult,
} from "ai";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getModel } from "@openacme/llm-provider";
import { createLogger } from "@openacme/config/logger";
import { toolCallContext, type ToolRegistry } from "@openacme/tools";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  MemoryStore,
  memoryAge,
  memoryFreshnessText,
} from "@openacme/memory";
import { TaskStore } from "@openacme/tasks";
import type {
  SessionStore,
  MessageStore,
  StoredUIMessage,
  InboxStore,
  InboxRow,
} from "@openacme/db";
import { buildSystemPrompt } from "./prompt.js";
import { Compressor } from "./compression.js";
import { findRelevantMemories, type RelevantMemory } from "./selector.js";
import { collectSurfacedMemories } from "./surfaced.js";
import { runExtractor } from "./extractor.js";
import {
  runTitle,
  extractTitleInputs,
  sliceFallbackTitle,
} from "./title.js";
import {
  anthropicCachePolicy,
  applyAnthropicCacheControl,
} from "./cache-control.js";
import {
  uiToModelMessages,
  parseAttachmentUrl,
  sanitizeStoredHistory,
  ensureStepBoundaries,
  finalizeOrphanToolParts,
} from "./messages.js";
import type { AgentConfig, MessageMetadata, TokenUsage } from "./types.js";

const log = createLogger("agent-core.agent");

const DEFAULT_AUTONOMOUS_TIMEOUT_MS = 5 * 60 * 1000;

// Recall budgets (ports of Claude Code RELEVANT_MEMORIES_CONFIG +
// MAX_MEMORY_BYTES/LINES from utils/attachments.ts). Per-memory caps
// keep one huge entry from swallowing the per-turn budget; the session
// cap stops recall once context already has enough.
const MAX_SESSION_RECALL_BYTES = 60 * 1024;
const MAX_MEMORY_BYTES = 4096;
const MAX_MEMORY_LINES = 200;

function truncateForSurfacing(
  body: string,
  logicalPath: string
): string {
  const lines = body.split("\n");
  const lineTruncated = lines.length > MAX_MEMORY_LINES;
  let head = lineTruncated ? lines.slice(0, MAX_MEMORY_LINES).join("\n") : body;
  let byteTruncated = false;
  if (Buffer.byteLength(head, "utf-8") > MAX_MEMORY_BYTES) {
    const buf = Buffer.from(head, "utf-8").subarray(0, MAX_MEMORY_BYTES);
    // Cut at the last newline within the byte budget so we don't slice
    // mid-character or mid-line.
    const cut = buf.lastIndexOf(0x0a);
    head = (cut > 0 ? buf.subarray(0, cut) : buf).toString("utf-8");
    byteTruncated = true;
  }
  if (!lineTruncated && !byteTruncated) return body;
  const reason = byteTruncated
    ? `${MAX_MEMORY_BYTES} byte limit`
    : `first ${MAX_MEMORY_LINES} lines`;
  return (
    head +
    `\n\n> This memory file was truncated (${reason}). Use the \`memory\` tool's \`view\` command to read the complete file at ${logicalPath}.`
  );
}

// Stale cursor (post-compaction) → treat all as new rather than silently
// disabling extraction.
function countMessagesAfter(
  messages: readonly UIMessage[],
  sinceUuid: string | undefined
): number {
  if (!sinceUuid) return messages.length;
  let found = false;
  let count = 0;
  for (const m of messages) {
    if (!found) {
      if (m.id === sinceUuid) found = true;
      continue;
    }
    count++;
  }
  return found ? count : messages.length;
}

function lastAssistantId(messages: readonly UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return messages[i]!.id;
  }
  return undefined;
}

export const __test = { countMessagesAfter, lastAssistantId };

function extractTriggerText(history: UIMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || !Array.isArray(m.parts)) continue;
    for (const p of m.parts) {
      if (
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string"
      ) {
        const t = ((p as { text: string }).text ?? "").trim();
        if (t.length > 0) return t;
      }
    }
  }
  return null;
}

export class AutonomousTurnTimeout extends Error {
  readonly code = "autonomous_turn_timeout";
  constructor(message: string) {
    super(message);
    this.name = "AutonomousTurnTimeout";
  }
}

/**
 * Render inbox rows that are NOT user_messages into a single text
 * block. Returns `null` for empty (no rows or only user_message rows).
 *
 * user_message rows are skipped here because the user message has
 * already been persisted to the chat history (`/api/chat` writes it
 * directly when the message arrives mid-turn, before queuing the
 * inbox row). Re-rendering it inside a `<system-event>` wake row
 * would duplicate the message in the agent's context.
 *
 * system_notice → `[system] <eventKind> on <relatedTask|session> by
 * <sourceId>: <payload-summary>`.
 */
function renderInboxItems(items: InboxRow[]): string | null {
  const nonUser = items.filter((i) => i.kind !== "user_message");
  if (nonUser.length === 0) return null;
  const lines: string[] = [];
  for (const item of nonUser) {
    const p = item.payload as {
      eventKind?: string;
      payload?: unknown;
    } | null;
    const kind = p?.eventKind ?? "notice";
    const anchor = item.relatedTask
      ? `task ${item.relatedTask}`
      : item.relatedSession
        ? `session ${item.relatedSession}`
        : "this session";
    const by = item.sourceId ?? "system";
    const detail = p?.payload ? ` ${JSON.stringify(p.payload)}` : "";
    lines.push(`[system] ${kind} on ${anchor} by ${by}${detail}`);
  }
  return lines.join("\n\n");
}

/**
 * The wake message wrapper. Brief intro + rendered inbox content (if
 * any). Wrapped in `<system-event>` tags so the model recognizes it as
 * a system-driven turn rather than human input, and so the web UI can
 * style it (matched against `metadata.kind === "autonomous_event"`).
 */
function buildWakeText(inboxText: string | null): string {
  const intro = inboxText
    ? "Autonomous turn — incoming signals since you last looked:"
    : "Autonomous turn — no new signals; scan your queue.";
  const body = inboxText ? `\n\n${inboxText}` : "";
  return `<system-event>\n${intro}${body}\n</system-event>`;
}

/**
 * Owns prompt assembly, tool resolution, the per-session prompt cache,
 * and the recall/extractor lifecycle. Host (HTTP route or CLI) drives
 * the stream and persistence.
 */
/** Structural subset of the server's SessionBroadcaster used by
 *  `runAutonomous` to push UIMessage stream chunks + appended messages
 *  to SSE subscribers. Kept in agent-core so the package stays free
 *  of a runtime dep on @openacme/server. */
export interface AutonomousBroadcaster {
  broadcast(
    sessionId: string,
    event:
      | { kind: "ui_message_part"; part: unknown }
      | {
          kind: "messages_appended";
          messages: Array<{
            id: string;
            role: "user" | "assistant";
            parts: unknown[];
            metadata?: unknown;
          }>;
        }
  ): void;
}

export class Agent {
  readonly config: AgentConfig;
  readonly sessionStore: SessionStore;
  readonly messageStore: MessageStore;
  readonly toolRegistry: ToolRegistry;
  readonly attachmentsRoot: string;
  readonly memoryStore: MemoryStore;
  readonly taskStore: TaskStore;
  readonly inboxStore: InboxStore;
  readonly broadcaster: AutonomousBroadcaster | null;
  readonly compressor = new Compressor();
  private cachedSystemPrompts = new Map<string, string>();
  // Cursor: id of the last assistant covered by an extractor run.
  private extractionCursor = new Map<string, string>();
  // Coalesces re-entrant fires (fast successive turns → one fork).
  private extractionInProgress = new Set<string>();
  // Per-session lock so concurrent onFinish callbacks coalesce into one
  // structured-subagent call. Released in `.finally(...)`.
  private titleInProgress = new Set<string>();

  constructor(
    config: AgentConfig,
    deps: {
      sessionStore: SessionStore;
      messageStore: MessageStore;
      toolRegistry: ToolRegistry;
      attachmentsRoot: string;
      /** Per-agent memory store, shared with the `memory` tool's binding so
       *  both paths use the same in-process mutex. */
      memoryStore: MemoryStore;
      /** Shared task store. Same instance is bound to the task tools and
       *  driven by the server-side TaskScheduler. */
      taskStore: TaskStore;
      /** Per-agent delivery queue. Drained at turn start + at LLM-step
       *  boundaries; rows hard-deleted after delivery. The autonomous
       *  loop reads from here for both initial wake content and
       *  mid-turn signal injection. */
      inboxStore: InboxStore;
      /** Optional UI broadcaster. When present, autonomous turns push
       *  their UIMessage stream chunks here so SSE-subscribed clients
       *  see the run live. Interactive turns don't use this — the
       *  caller already consumes the stream directly. */
      broadcaster?: AutonomousBroadcaster | null;
    }
  ) {
    this.config = config;
    this.sessionStore = deps.sessionStore;
    this.messageStore = deps.messageStore;
    this.toolRegistry = deps.toolRegistry;
    this.attachmentsRoot = deps.attachmentsRoot;
    this.memoryStore = deps.memoryStore;
    this.taskStore = deps.taskStore;
    this.inboxStore = deps.inboxStore;
    this.broadcaster = deps.broadcaster ?? null;
  }

  /** `history` MUST end in the new user message. Caller drives the returned stream. */
  async runStream(opts: {
    sessionId: string;
    history: UIMessage[];
    signal?: AbortSignal;
    /** Tighter step cap for forks. Defaults to `config.maxSteps`. */
    stopWhen?: Parameters<typeof streamText>[0]["stopWhen"];
    /** Subset of `config.tools` to expose this call. Forks restrict to
     *  what's safe unsupervised (extractor → memory only). */
    toolFilter?: ReadonlySet<string>;
    /** Telemetry tag override (Logfire). No-op unless OPENACME_TELEMETRY=1. */
    telemetryFunctionId?: string;
    /** Hook between LLM steps — used by `runAutonomous` to inject events
     *  that arrived mid-turn. Forwarded to `streamText` unchanged. */
    prepareStep?: Parameters<typeof streamText>[0]["prepareStep"];
  }): Promise<StreamTextResult<ToolSet, never>> {
    const effectiveToolNames = opts.toolFilter
      ? this.config.tools.filter((t) => opts.toolFilter!.has(t))
      : this.config.tools;
    const tools = this.toolRegistry.getVercelTools(
      new Set(effectiveToolNames)
    );

    // ALS: tool handlers read sessionId/agentId/workspaceDir without arg-threading.
    toolCallContext.enterWith({
      sessionId: opts.sessionId,
      agentId: this.config.id,
      workspaceDir: this.config.workspaceDir,
    });

    const messages = await uiToModelMessages(opts.history, {
      attachmentsRoot: this.attachmentsRoot,
      tools: tools as ToolSet,
    });

    const system = this.getSystemPrompt(opts.sessionId);
    const { system: cachedSystem, messages: cachedMessages } =
      this.applyPromptCaching(system, messages);

    return streamText({
      model: getModel(this.config.model),
      system: cachedSystem,
      messages: cachedMessages,
      tools: tools as Parameters<typeof streamText>[0]["tools"],
      stopWhen: opts.stopWhen ?? stepCountIs(this.config.maxSteps),
      abortSignal: opts.signal,
      prepareStep: opts.prepareStep,
      // Anthropic native cache-control requires the system prompt to live
      // in `messages` as a `role: "system"` entry; SDK warns by default.
      allowSystemInMessages: true,
      experimental_telemetry: {
        isEnabled: true,
        functionId: opts.telemetryFunctionId ?? this.config.id,
        metadata: { sessionId: opts.sessionId },
      },
    });
  }

  // Native Anthropic only: fold system into messages to attach cacheControl
  // breakpoints. OpenRouter Claude is handled at the fetch layer.
  private applyPromptCaching(
    system: string,
    messages: import("ai").ModelMessage[]
  ): {
    system: string | undefined;
    messages: import("ai").ModelMessage[];
  } {
    if (anthropicCachePolicy(this.config.model) !== "native") {
      return { system, messages };
    }
    const withSystem: import("ai").ModelMessage[] = [
      { role: "system", content: system },
      ...messages,
    ];
    return {
      system: undefined,
      messages: applyAnthropicCacheControl(withSystem),
    };
  }

  /**
   * Run one autonomous turn for `taskId` in `sessionId`. Drains the
   * stream server-side (no HTTP/SSE) and persists the user prompt +
   * assistant response. Caller (TaskScheduler) is responsible for the
   * task's status transitions; this method only times out after
   * `autonomousTurnTimeoutMs` (default 5 min) and throws
   * `AutonomousTurnTimeout` on expiry.
   *
   * Returns the assistant UIMessage that was persisted.
   */
  async runAutonomous(opts: {
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<{ assistant: UIMessage; usage?: TokenUsage }> {
    // Guard against concurrent session deletion (scheduler created it
    // in its tick; could vanish before we run).
    if (!this.sessionStore.get(opts.sessionId)) {
      throw new Error(
        `Session ${opts.sessionId} no longer exists; aborting autonomous turn`
      );
    }

    // Find the task currently in_progress in this session, if any. Used
    // for the memory-recall trigger and (in the scheduler) for failure
    // attribution. The store invariant guarantees at most one in-progress
    // per session, so the array has 0 or 1 entry; no assignee filter is
    // needed (sessions are agent-scoped).
    const inProgress = this.taskStore.list({
      session_id: opts.sessionId,
      status: "in_progress",
    })[0];

    // Drain the per-agent inbox. Every event emit fans out a row here
    // (see AgentManager's `eventStore.onEmit` hook, with same-agent
    // echo suppression at the delivery boundary). Anything the agent
    // should know about since its last turn is in this list. The rows
    // are hard-deleted once we've materialized them into chat history
    // below — the inbox is staging, the chat is the audit.
    let pendingInbox: InboxRow[] = [];
    try {
      pendingInbox = this.inboxStore.pendingFor(this.config.id);
    } catch (e) {
      log.warn(
        { err: e, agentId: this.config.id, sessionId: opts.sessionId },
        "inboxStore.pendingFor failed; turn will run without inbox content"
      );
    }

    // Filter inbox rows to those for THIS session: user_messages with a
    // matching relatedSession get persisted as real user-role chat rows
    // here. user_messages for OTHER sessions stay in the inbox (different
    // session's turn drains them). system_notices ride along regardless.
    const queuedUserMessagesForThisSession = pendingInbox.filter(
      (i) =>
        i.kind === "user_message" && i.relatedSession === opts.sessionId
    );
    const drainedUserMessage = queuedUserMessagesForThisSession.length > 0;

    // Persist + broadcast each queued user message NOW so it lands in
    // chat history with a timestamp after the in-flight turn's
    // assistant (if any). The autonomous turn that's about to run
    // will respond to these messages. Reuse the original message id
    // from the payload so the UI's optimistic upsert collapses.
    for (const row of queuedUserMessagesForThisSession) {
      const payload = row.payload as
        | { id?: string; role?: string; parts?: unknown[] }
        | null;
      if (!payload || payload.role !== "user" || !Array.isArray(payload.parts)) {
        continue;
      }
      const msgId =
        typeof payload.id === "string" && payload.id ? payload.id : randomUUID();
      try {
        this.messageStore.append(opts.sessionId, {
          id: msgId,
          role: "user",
          parts: payload.parts,
        });
        this.broadcaster?.broadcast(opts.sessionId, {
          kind: "messages_appended",
          messages: [{ id: msgId, role: "user", parts: payload.parts }],
        });
      } catch (e) {
        log.warn(
          { err: e, msgId, sessionId: opts.sessionId },
          "failed to persist queued user message; row will not be re-rendered"
        );
      }
    }

    const inboxText = renderInboxItems(pendingInbox);
    const baseHistory = sanitizeStoredHistory(
      this.messageStore.getHistory(opts.sessionId)
    ) as unknown as UIMessage[];

    // "Has the agent already responded to every real user message in
    // history?" Walk backwards: if we hit a real (non-autonomous) user
    // message before any assistant, there's an unanswered user message.
    let unansweredUser = false;
    for (let i = baseHistory.length - 1; i >= 0; i--) {
      const m = baseHistory[i]!;
      if (m.role === "assistant") break;
      if (
        m.role === "user" &&
        (m.metadata as MessageMetadata | undefined)?.kind !== "autonomous_event"
      ) {
        unansweredUser = true;
        break;
      }
    }

    // Wake-row decision:
    //   (a) `inboxText` non-null  → system_notices to surface; write a
    //       wake row containing them. Wake row exists.
    //   (b) drained a user_message OR there's an unanswered user
    //       message in history → no wake row; history's user message
    //       is what the agent responds to. (The mid-turn /api/chat
    //       queue path persists the user msg BEFORE writing the
    //       inbox row, so it's already in history by the time we
    //       get here.)
    //   (c) Neither → continuation/health-check wake. Write a brief
    //       wake row so the model has something to respond to.
    let userMessage: UIMessage | null = null;
    if (inboxText) {
      userMessage = {
        id: randomUUID(),
        role: "user",
        parts: [{ type: "text", text: buildWakeText(inboxText) }],
        metadata: { kind: "autonomous_event" } satisfies MessageMetadata,
      };
    } else if (!drainedUserMessage && !unansweredUser) {
      userMessage = {
        id: randomUUID(),
        role: "user",
        parts: [{ type: "text", text: buildWakeText(null) }],
        metadata: { kind: "autonomous_event" } satisfies MessageMetadata,
      };
    }

    const history = userMessage ? [...baseHistory, userMessage] : baseHistory;

    // Persist + broadcast the synthesized wake row BEFORE the assistant
    // turn runs (mirroring /api/chat): keeps `ping_user`'s inbox
    // resolution rule honest about ordering, and lets SSE-subscribed
    // tabs render the wake row at the same instant the assistant
    // stream starts. Skipped entirely when there's no wake row.
    let persistSucceeded = userMessage === null;
    if (userMessage) {
      try {
        this.messageStore.append(opts.sessionId, {
          id: userMessage.id,
          role: "user",
          parts: userMessage.parts as unknown[],
          metadata: { kind: "autonomous_event" },
        });
        persistSucceeded = true;
        this.broadcaster?.broadcast(opts.sessionId, {
          kind: "messages_appended",
          messages: [
            {
              id: userMessage.id,
              role: "user",
              parts: userMessage.parts as unknown[],
              metadata: { kind: "autonomous_event" },
            },
          ],
        });
      } catch (e) {
        log.warn({ err: e }, "runAutonomous: failed to pre-persist auto user message");
      }
    }

    // Hard-delete rows we've handled. We've handled:
    //   - All queued user_messages for THIS session (persisted above).
    //   - system_notice rows once the wake row is persisted (or if
    //     there is no wake row because we skipped it; either way the
    //     system_notice is reflected in the prompt or correctly judged
    //     unneeded).
    // user_messages addressed to OTHER sessions stay in the inbox so
    // their session's turn picks them up.
    const idsToDelete: number[] = [];
    for (const row of pendingInbox) {
      if (row.kind === "user_message") {
        if (row.relatedSession === opts.sessionId) idsToDelete.push(row.id);
        // else: leave for other session
      } else {
        // system_notice — drained whether or not the wake row landed,
        // since we either rendered it into a persisted wake row or
        // deliberately skipped (e.g., would have been redundant).
        if (persistSucceeded) idsToDelete.push(row.id);
      }
    }
    if (idsToDelete.length > 0) {
      try {
        this.inboxStore.deleteDelivered(idsToDelete);
      } catch (e) {
        log.warn(
          { err: e, count: idsToDelete.length },
          "inboxStore.deleteDelivered failed; rows may re-deliver"
        );
      }
    }

    const timeoutMs =
      this.config.autonomousTurnTimeoutMs ?? DEFAULT_AUTONOMOUS_TIMEOUT_MS;
    const timeoutAbort = new AbortController();
    const timer = setTimeout(() => timeoutAbort.abort(), timeoutMs);
    const externalAbort = opts.signal;
    const onExternalAbort = () => timeoutAbort.abort();
    if (externalAbort) {
      if (externalAbort.aborted) timeoutAbort.abort();
      else externalAbort.addEventListener("abort", onExternalAbort);
    }

    let timedOut = false;
    let usage: TokenUsage | undefined;
    let assistantMessage: UIMessage | null = null;

    const recall = inProgress
      ? await this.applyMemoryRecall({
          history,
          signal: timeoutAbort.signal,
          triggerText: inProgress.title,
        }).catch(() => ({ entries: [], modelContent: null }))
      : { entries: [], modelContent: null };

    // Memory recall: attach a "relevant memory" part to the LAST
    // user-role message the model will see, so the cached system
    // prompt can stay clean. With the wake row optional now, attach
    // to the wake row if present, otherwise to the most-recent real
    // user message in history (typically the queued mid-turn one).
    // Attach in-memory only — recall already runs per-turn and isn't
    // persisted to the chat row.
    const recallPart = this.buildRelevantMemoryPart(
      recall.entries,
      recall.modelContent
    );
    if (recallPart) {
      const target =
        userMessage ??
        ([...history].reverse().find((m) => m.role === "user") as
          | UIMessage
          | undefined);
      if (target) {
        target.parts = [
          ...(target.parts as UIMessage["parts"]),
          recallPart as unknown as UIMessage["parts"][number],
        ];
      }
    }

    // Mid-turn inbox drain: between LLM steps, splice any signals that
    // landed since the last drain (either turn start or the previous
    // step boundary). Rows arrive here from the same inbox the turn-
    // start drain reads — echo suppression (don't re-deliver this
    // agent's own actions) happens at the emit boundary in
    // AgentManager, so anything we see here is for-this-agent and
    // not self-authored. Wrapped in a `user` role message — mid-stream
    // `system` role is non-standard for Anthropic and breaks prefix
    // prompt-cache.
    let injectionCount = 0;
    const MAX_INJECTIONS = 5;
    const turnAgentId = this.config.id;
    const turnInboxStore = this.inboxStore;
    const turnSessionId = opts.sessionId;
    const prepareStep: Parameters<typeof streamText>[0]["prepareStep"] = (
      stepOpts
    ) => {
      if (stepOpts.stepNumber === 0) return undefined;
      if (injectionCount >= MAX_INJECTIONS) return undefined;
      try {
        const fresh = turnInboxStore.pendingFor(turnAgentId);
        if (fresh.length === 0) return undefined;
        const formatted = renderInboxItems(fresh);
        if (!formatted) return undefined;
        try {
          turnInboxStore.deleteDelivered(fresh.map((r) => r.id));
        } catch (e) {
          log.warn(
            { err: e, sessionId: turnSessionId },
            "mid-turn inbox delete failed; rows may re-inject"
          );
        }
        injectionCount++;
        return {
          messages: [
            ...stepOpts.messages,
            {
              role: "user",
              content:
                "<system-event>\n" +
                "New signals landed while you were working — review and react if relevant, otherwise keep going.\n\n" +
                formatted +
                "\n</system-event>",
            },
          ],
        };
      } catch (e) {
        log.warn(
          { err: e, sessionId: turnSessionId },
          `Mid-turn inbox drain failed for ${turnSessionId}`
        );
        return undefined;
      }
    };

    try {
      const result = await this.runStream({
        sessionId: opts.sessionId,
        history,
        signal: timeoutAbort.signal,
        prepareStep,
      });

      // Hand-rolling from `fullStream` skips step boundaries that
      // downstream conversion relies on — use the SDK assembler.
      // Default `sendStart: true` so each autonomous turn's chunks
      // carry their own start/finish markers. The broadcaster channel
      // is long-lived across turns — without those markers,
      // `readUIMessageStream` on the subscriber side accumulates every
      // turn into one ever-growing UIMessage.
      const uiStream = result.toUIMessageStream();
      // Fan the stream out: one branch feeds the assembler that builds
      // the persisted UIMessage; the other broadcasts raw parts to
      // SSE subscribers so the chat pane streams live. `tee` is a
      // standard ReadableStream method; both branches must be drained
      // (or one will back-pressure the source).
      let assemblerStream = uiStream;
      if (this.broadcaster) {
        const [a, b] = uiStream.tee();
        assemblerStream = a;
        const sid = opts.sessionId;
        const bc = this.broadcaster;
        void (async () => {
          const reader = b.getReader();
          try {
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              try {
                bc.broadcast(sid, { kind: "ui_message_part", part: r.value });
              } catch (e) {
                // Body kept verbatim — referenced in scheduler docs.
                log.warn({ err: e }, "runAutonomous broadcaster part failed");
              }
            }
          } finally {
            reader.releaseLock();
          }
        })();
      }
      for await (const m of readUIMessageStream<UIMessage>({
        stream: assemblerStream,
      })) {
        assistantMessage = m;
        if (timeoutAbort.signal.aborted) {
          timedOut = true;
          break;
        }
      }

      if (!timedOut) {
        const u = await result.usage;
        usage = {
          inputTokens: u?.inputTokens,
          outputTokens: u?.outputTokens,
          totalTokens: u?.totalTokens,
        };
      }
    } catch (e) {
      if (timeoutAbort.signal.aborted) {
        timedOut = true;
      } else {
        // No cursor to advance — the inbox rows that were drained at
        // turn start are already deleted, and their content is in the
        // persisted chat row above (so the agent's history still
        // reflects what we tried to deliver). New signals arriving
        // post-failure will be in the inbox for the next turn.
        clearTimeout(timer);
        if (externalAbort) {
          externalAbort.removeEventListener("abort", onExternalAbort);
        }
        throw e;
      }
    } finally {
      clearTimeout(timer);
      if (externalAbort) {
        externalAbort.removeEventListener("abort", onExternalAbort);
      }
    }

    if (timedOut) {
      throw new AutonomousTurnTimeout(
        `Autonomous turn timed out after ${timeoutMs}ms in session ${opts.sessionId}`
      );
    }
    if (!assistantMessage) {
      throw new Error(
        `Autonomous turn in session ${opts.sessionId} produced no assistant message`
      );
    }

    // User message was pre-persisted + pre-broadcast above so any
    // `ping_user` events fired during the turn aren't auto-resolved.
    const assistantParts = assistantMessage.parts as UIMessage["parts"];
    if (assistantParts.length > 0) {
      const sanitized = ensureStepBoundaries(
        finalizeOrphanToolParts(assistantParts)
      );
      const assistantId = assistantMessage.id ?? randomUUID();
      this.messageStore.append(opts.sessionId, {
        id: assistantId,
        role: "assistant",
        parts: sanitized as unknown[],
      });
      // Final broadcast of the assembled assistant message so SSE
      // subscribers settle on the same id+parts shape the DB sees.
      // The streaming `ui_message_part` arrivals already produced an
      // assembled UIMessage with this same id, so this is an upsert
      // no-op for clients that received the live stream.
      this.broadcaster?.broadcast(opts.sessionId, {
        kind: "messages_appended",
        messages: [
          {
            id: assistantId,
            role: "assistant",
            parts: sanitized as unknown[],
          },
        ],
      });
      const stored = this.messageStore.getHistory(opts.sessionId);
      this.fireExtractor({
        sessionId: opts.sessionId,
        sessionMessages: stored as unknown as UIMessage[],
      });
    }

    // No cursor advance — inbox-drain-and-delete is the new
    // incrementality mechanism. Rows we rendered (turn start + mid-
    // turn) are already gone from the inbox; what remains is fresh
    // for the next turn.

    return { assistant: assistantMessage, usage };
  }

  /**
   * Compress a session synchronously. Loads parent history, runs the
   * Compressor pipeline, creates a child session, and persists the new
   * UIMessage list. Returns the new child id, or the parent id if
   * compression was a no-op.
   */
  async compress(
    parentSessionId: string,
    reason: "proactive" | "payload_too_large" | "context_overflow"
  ): Promise<string> {
    const parent = this.sessionStore.get(parentSessionId);
    if (!parent) return parentSessionId;

    const existingChild = this.sessionStore.findChildOf(parentSessionId);
    if (existingChild) {
      this.compressor.inheritState(parentSessionId, existingChild.id);
      return existingChild.id;
    }

    if (!this.config.compression) return parentSessionId;

    const parentMessages = sanitizeStoredHistory(
      this.messageStore.getHistory(parentSessionId)
    ) as unknown as UIMessage[];

    // Pre-compaction memory flush (port from OpenClaw): give the agent one
    // silent turn to externalize anything important to MEMORY.md before
    // the older portion of context is summarized away. Best-effort —
    // a flush failure (often the same context-overflow that triggered
    // the compression in the first place) must not block recovery.
    await this.flushMemoryBeforeCompression(parentSessionId, parentMessages);
    const result = await this.compressor.compress({
      parentSessionId,
      parentMessages,
      config: this.config.compression,
      mainModel: this.config.model,
      reason,
    });

    if (result.noOp || result.childMessages.length === 0) {
      return parentSessionId;
    }

    const child = this.sessionStore.createChildIfNoSibling(
      this.config.id,
      parentSessionId,
      { title: parent.title ?? undefined }
    );
    if (!child) {
      const won = this.sessionStore.findChildOf(parentSessionId);
      if (won) {
        this.compressor.inheritState(parentSessionId, won.id);
        return won.id;
      }
      return parentSessionId;
    }

    try {
      // Verbatim head/tail copies of user UIMessages may carry
      // FileUIParts whose URL points at the PARENT session's attachments
      // dir. The parent session is hidden post-fork; if it ever gets
      // deleted, those files would disappear and the child's bubbles
      // would 404. Copy the bytes under the child's session dir and
      // rewrite the URL before persisting.
      const rebound = result.childMessages.map((m) =>
        this.rebindAttachmentsForChild(m, parentSessionId, child.id)
      );
      // Each child row needs a fresh primary key — the parent session's
      // rows live in the same `messages` table and the original ids are
      // already taken. We rewrite ids here rather than inside the
      // Compressor so the algorithm stays free to use parent ids for
      // its head/tail bookkeeping.
      // `stepsToUIMessages` rebuilds parts without step-start markers;
      // re-inject so the child session converts cleanly on the next turn.
      const rows: StoredUIMessage[] = rebound.map((m) => ({
        id: randomUUID(),
        role: m.role as "user" | "assistant",
        parts: ensureStepBoundaries(
          finalizeOrphanToolParts(m.parts as UIMessage["parts"])
        ) as unknown[],
        metadata: m.metadata,
      }));
      this.messageStore.appendMany(child.id, rows);
    } catch (e) {
      // Body kept verbatim — referenced in CLAUDE.md compression notes.
      log.error(
        { err: e, childSessionId: child.id },
        `Failed to persist compressed messages for ${child.id}`
      );
      throw e;
    }

    this.compressor.inheritState(parentSessionId, child.id);
    this.compressor.recordResult(child.id, result.savingsRatio, result.summary);
    this.cachedSystemPrompts.delete(parentSessionId);
    return child.id;
  }

  /**
   * Walk a single child UIMessage's parts; for any FileUIPart whose URL
   * resolves to a path under the parent's session dir, copy the file
   * to a fresh `<childSessionId>/<newAttId>/<filename>` location and
   * rewrite the URL to match. Other URL shapes (`data:`, external
   * https, or already-rebound child URLs) pass through unchanged.
   */
  private rebindAttachmentsForChild(
    m: UIMessage,
    parentSessionId: string,
    childSessionId: string
  ): UIMessage {
    if (m.role !== "user") return m;
    let mutated = false;
    const parts = m.parts.map((p) => {
      if ((p as { type?: unknown }).type !== "file") return p;
      const fp = p as { url?: string };
      if (typeof fp.url !== "string") return p;
      const rel = parseAttachmentUrl(fp.url);
      // Only rewrite when the URL is rooted in the PARENT session.
      // Already-child / data: / external URLs pass through.
      if (!rel || !rel.startsWith(`${parentSessionId}/`)) return p;
      const filename = rel.split("/").pop() ?? "file";
      const newAttId = `att_${randomUUID()}`;
      const newRel = `${childSessionId}/${newAttId}/${filename}`;
      const srcAbs = path.join(this.attachmentsRoot, rel);
      const dstAbs = path.join(this.attachmentsRoot, newRel);
      try {
        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
        fs.copyFileSync(srcAbs, dstAbs);
      } catch (e) {
        log.error(
          { err: e, src: srcAbs, dst: dstAbs },
          "compression: failed to copy attachment"
        );
        // File didn't copy — leave the URL alone; the next render will
        // 404 against this attachment but the rest of the message
        // survives. Better than aborting the whole compression.
        return p;
      }
      mutated = true;
      return { ...(p as object), url: `/api/attachments/${newRel}` } as typeof p;
    });
    return mutated ? ({ ...m, parts } as UIMessage) : m;
  }

  /**
   * Pre-compaction memory flush. Runs `generateText` with the current
   * history + a one-line nudge prompting the agent to call the `memory`
   * tool for any context worth saving before older messages are summarized.
   *
   * Tool set is restricted to `memory` only — we don't want the flush
   * turn to issue shell/edit/etc. side effects. AbortSignal is intentionally
   * NOT plumbed: the flush should complete or fail on its own; cancelling
   * mid-flush is more disruptive than the alternative.
   *
   * Failure is swallowed: the flush is a write-through optimization, not
   * a correctness requirement. Compression proceeds either way.
   */
  private async flushMemoryBeforeCompression(
    sessionId: string,
    history: UIMessage[]
  ): Promise<void> {
    try {
      const tools = this.toolRegistry.getVercelTools(new Set(["memory"]));
      // Reuse the cached system prompt so the flush turn sees the same
      // memory header and tool guidance the main turn uses.
      const system = this.getSystemPrompt(sessionId);
      const messages = await uiToModelMessages(history, {
        attachmentsRoot: this.attachmentsRoot,
        tools: tools as ToolSet,
      });
      // Re-enter ALS in case this method is called from a context where
      // `enterWith` wasn't already issued (e.g. a future direct call from
      // a route). Safe to re-set the same ids.
      toolCallContext.enterWith({
        sessionId,
        agentId: this.config.id,
        workspaceDir: this.config.workspaceDir,
      });
      const flushMessages: import("ai").ModelMessage[] = [
        ...messages,
        {
          role: "user",
          content:
            "Pre-compaction memory flush. Older messages in this conversation will be summarized away shortly. Use the `memory` tool to save any durable facts, preferences, decisions, or environment details that should survive into future sessions. If nothing is worth saving, respond with a single word and stop.",
        },
      ];
      const { system: cachedSystem, messages: cachedMessages } =
        this.applyPromptCaching(system, flushMessages);
      await generateText({
        model: getModel(this.config.model),
        system: cachedSystem,
        messages: cachedMessages,
        tools: tools as Parameters<typeof generateText>[0]["tools"],
        stopWhen: stepCountIs(this.config.maxSteps),
        experimental_telemetry: {
          isEnabled: true,
          functionId: `${this.config.id}:memory-flush`,
          metadata: { sessionId },
        },
      });
    } catch (e) {
      // Body kept verbatim — referenced in CLAUDE.md / agent-core rules.
      log.warn(
        { err: e, sessionId },
        `Pre-compaction memory flush failed for ${sessionId}`
      );
    }
  }

  private getSystemPrompt(sessionId: string): string {
    const cached = this.cachedSystemPrompts.get(sessionId);
    if (cached) return cached;

    const configuredTools = this.config.tools;
    const resolvedTools: string[] = [];
    const missingTools: string[] = [];
    for (const name of configuredTools) {
      if (this.toolRegistry.get(name) !== undefined) {
        resolvedTools.push(name);
      } else {
        missingTools.push(name);
      }
    }
    if (missingTools.length > 0) {
      log.warn(
        { agentId: this.config.id, missingTools },
        "agent has missing tool references"
      );
    }

    // Frozen-snapshot pattern: load MEMORY.md once when the per-session
    // prompt is first built. Mid-session memory writes hit disk but DON'T
    // mutate the cached prompt — preserves the provider-side prefix cache
    // for the entire session. Next session reloads.
    let memorySnapshot: ReturnType<MemoryStore["readIndex"]> | undefined;
    try {
      memorySnapshot = this.memoryStore.readIndex(
        this.config.id,
        DEFAULT_MEMORY_CHAR_LIMIT
      );
    } catch (e) {
      log.warn(
        { err: e, agentId: this.config.id },
        "failed to read memory index"
      );
    }

    let tasksContext: string | undefined;
    try {
      const rendered = this.taskStore.renderForPrompt(
        this.config.id,
        sessionId,
        (sid: string) => this.sessionStore.get(sid) !== null
      );
      if (rendered) tasksContext = rendered;
    } catch (e) {
      log.warn(
        { err: e, agentId: this.config.id },
        "failed to render tasks for prompt"
      );
    }

    // Recent Activity is NOT in the cached system prompt — it's
    // appended to the autonomous user message at runAutonomous time so
    // it stays per-turn fresh and doesn't contaminate interactive
    // turns or the persisted sessions.system_prompt.

    const prompt = buildSystemPrompt({
      persona: this.config.persona,
      toolNames: resolvedTools,
      skillsIndex: this.config.skillsIndex,
      tasksContext,
      memorySnapshot,
      agentsMd: this.config.agentsMd,
      workspaceDir: this.config.workspaceDir,
      resources: this.config.resources,
    });
    this.cachedSystemPrompts.set(sessionId, prompt);

    try {
      this.sessionStore.updateSystemPrompt(sessionId, prompt);
    } catch (e) {
      log.error({ err: e, sessionId }, "failed to persist system prompt");
    }
    return prompt;
  }

  /**
   * Selector pass over the agent's memory dir. Caller appends the
   * resulting part (`buildRelevantMemoryPart`) to the user UIMessage,
   * before runStream and before persistence. Failure-tolerant: never
   * throws, returns empty when nothing is selectable.
   */
  async applyMemoryRecall(opts: {
    history: UIMessage[];
    signal?: AbortSignal;
    /** Override the inferred trigger text (chat: last user text;
     *  autonomous: pass task.title; peer/cron: pass payload body). */
    triggerText?: string;
    /** Recently-used tools — selector suppresses reference-doc hits. */
    recentTools?: readonly string[];
  }): Promise<{
    entries: Array<{ path: string; mtimeMs: number; content: string }>;
    /** Pre-rendered model-input bytes (freshness baked in). Persisted
     *  on the user msg, replayed verbatim each turn → prefix cache. */
    modelContent: string | null;
  }> {
    const triggerText = opts.triggerText ?? extractTriggerText(opts.history);
    if (!triggerText || triggerText.trim().length === 0) {
      return { entries: [], modelContent: null };
    }

    const memoryDir = this.memoryStore.dirPath(this.config.id);
    const surfaced = collectSurfacedMemories(opts.history);
    if (surfaced.totalBytes >= MAX_SESSION_RECALL_BYTES) {
      return { entries: [], modelContent: null };
    }

    let selected: RelevantMemory[];
    try {
      selected = await findRelevantMemories({
        parent: this,
        triggerText,
        memoryDir,
        recentTools: opts.recentTools,
        alreadySurfaced: surfaced.paths,
        signal: opts.signal,
      });
    } catch (e) {
      log.warn({ err: e, agentId: this.config.id }, "memory.recall selector failed");
      return { entries: [], modelContent: null };
    }

    if (selected.length === 0) {
      return { entries: [], modelContent: null };
    }

    const entries: Array<{ path: string; mtimeMs: number; content: string }> = [];
    for (const r of selected) {
      try {
        const body = fs.readFileSync(r.path, "utf-8");
        const rel = path.relative(memoryDir, r.path);
        const content = truncateForSurfacing(body, rel);
        entries.push({ path: r.path, mtimeMs: r.mtimeMs, content });
      } catch {
        // File vanished between scan and read.
      }
    }

    if (entries.length === 0) {
      return { entries: [], modelContent: null };
    }

    const blocks = entries.map((e) => {
      const rel = path.relative(memoryDir, e.path);
      const logicalPath = rel;
      const staleness = memoryFreshnessText(e.mtimeMs);
      const header = staleness
        ? `${staleness}\n\nMemory: ${logicalPath}:`
        : `Memory (saved ${memoryAge(e.mtimeMs)}): ${logicalPath}:`;
      return `<system-reminder>\n${header}\n\n${e.content}\n</system-reminder>`;
    });
    const modelContent = blocks.join("\n\n");

    return { entries, modelContent };
  }

  /** Builds the `data-relevant-memory` part for the user UIMessage. */
  buildRelevantMemoryPart(
    entries: Array<{ path: string; mtimeMs: number; content: string }>,
    modelContent: string | null
  ): {
    type: "data-relevant-memory";
    id: string;
    data: {
      entries: Array<{ path: string; mtimeMs: number; content: string }>;
      modelContent: string;
    };
  } | null {
    if (entries.length === 0 || !modelContent) return null;
    return {
      type: "data-relevant-memory",
      id: randomUUID(),
      data: { entries, modelContent },
    };
  }

  /**
   * Fire-and-forget post-turn extractor. Coalesces re-entrant fires;
   * cursor advances on completed/skipped-*, stays put on failure.
   */
  fireExtractor(opts: {
    sessionId: string;
    /** Session history including the just-finished assistant turn. */
    sessionMessages: readonly UIMessage[];
    abortSignal?: AbortSignal;
  }): void {
    if (this.extractionInProgress.has(opts.sessionId)) {
      return;
    }
    const cursor = this.extractionCursor.get(opts.sessionId);
    const newCount = countMessagesAfter(opts.sessionMessages, cursor);
    if (newCount <= 0) return;

    this.extractionInProgress.add(opts.sessionId);
    void runExtractor({
      agent: this,
      sessionId: opts.sessionId,
      sessionMessages: opts.sessionMessages,
      newMessageCount: newCount,
      abortSignal: opts.abortSignal,
    })
      .then((res) => {
        if (
          res.status === "completed" ||
          res.status === "skipped-main-wrote" ||
          res.status === "skipped-no-new-content"
        ) {
          const lastAsst = lastAssistantId(opts.sessionMessages);
          if (lastAsst) this.extractionCursor.set(opts.sessionId, lastAsst);
        }
        if (res.status === "failed") {
          log.warn(
            { agentId: this.config.id, sessionId: opts.sessionId, error: res.error ?? "unknown" },
            "memory.extractor failed"
          );
        }
      })
      .catch((e) => {
        log.warn(
          { err: e, agentId: this.config.id, sessionId: opts.sessionId },
          "memory.extractor threw"
        );
      })
      .finally(() => {
        this.extractionInProgress.delete(opts.sessionId);
      });
  }

  /**
   * Fire-and-forget session title generation. LLM (structured subagent)
   * primary; slice-of-first-assistant-text fallback. No-op if the session
   * already has a title or another title call is in flight.
   */
  fireTitle(opts: {
    sessionId: string;
    /** Session history including the just-finished assistant turn. */
    sessionMessages: readonly UIMessage[];
    abortSignal?: AbortSignal;
  }): void {
    if (this.titleInProgress.has(opts.sessionId)) return;

    const session = this.sessionStore.get(opts.sessionId);
    if (!session || session.title) return;

    const { userText, assistantText } = extractTitleInputs(opts.sessionMessages);
    if (!userText && !assistantText) return;

    const writeFallback = () => {
      const fallback = sliceFallbackTitle(opts.sessionMessages);
      if (!fallback) return;
      try {
        this.sessionStore.updateTitle(opts.sessionId, fallback);
      } catch (e) {
        log.warn(
          { err: e, agentId: this.config.id, sessionId: opts.sessionId },
          "title fallback write failed"
        );
      }
    };

    this.titleInProgress.add(opts.sessionId);
    void runTitle({
      parent: this,
      userText,
      assistantText,
      abortSignal: opts.abortSignal,
    })
      .then((title) => {
        if (title) {
          this.sessionStore.updateTitle(opts.sessionId, title);
          return;
        }
        writeFallback();
      })
      .catch((e) => {
        log.warn(
          { err: e, agentId: this.config.id, sessionId: opts.sessionId },
          "title generation threw"
        );
        writeFallback();
      })
      .finally(() => {
        this.titleInProgress.delete(opts.sessionId);
      });
  }

  /** Get conversation history for a session as persisted UIMessages. */
  getHistory(sessionId: string): StoredUIMessage[] {
    return this.messageStore.getHistory(sessionId);
  }

  /** Invalidate the cached system prompt for a session. */
  invalidateSystemPromptCache(sessionId?: string): void {
    if (sessionId) {
      this.cachedSystemPrompts.delete(sessionId);
    } else {
      this.cachedSystemPrompts.clear();
    }
  }
}
