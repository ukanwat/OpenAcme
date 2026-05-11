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
import { toolCallContext, type ToolRegistry } from "@openacme/tools";
import {
  MemoryStore,
  memoryAge,
  memoryFreshnessText,
} from "@openacme/memory";
import { TaskStore, TaskStoreError } from "@openacme/tasks";
import type { SessionStore, MessageStore, StoredUIMessage } from "@openacme/db";
import { buildSystemPrompt } from "./prompt.js";
import { Compressor } from "./compression.js";
import { findRelevantMemories, type RelevantMemory } from "./selector.js";
import { collectSurfacedMemories } from "./surfaced.js";
import { runExtractor } from "./extractor.js";
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
import type { AgentConfig, TokenUsage } from "./types.js";

const DEFAULT_AUTONOMOUS_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Cumulative cap on bytes surfaced via recall across a single session.
 * Verbatim port of Claude Code `RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES`
 * (`utils/attachments.ts:290`). Once a session crosses this, recall stops
 * — the most-relevant entries are already in context, and continuing to
 * surface dilutes attention with no upside. Compaction resets the
 * counter naturally (old attachments are gone from the compacted view).
 */
const MAX_SESSION_RECALL_BYTES = 60 * 1024;

/**
 * Pull a usable trigger description out of the supplied history. Walks
 * back from the end and returns the first text-part body found — chat
 * messages, autonomous task prompts, and synthetic peer messages all
 * carry their work-item text in a text part. Returns null if nothing
 * matches (recall then no-ops).
 */
/**
 * Count UIMessages strictly AFTER the message whose id is `sinceUuid`.
 * Returns the full length when the cursor is undefined (first run) or
 * stale (e.g. compaction removed the cursor message — fall back to
 * "treat everything as new" rather than silently disabling extraction).
 */
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

// Exported only for unit tests — tight, pure helpers that benefit from
// direct coverage rather than going through the runStream stack.
export const __test = {
  countMessagesAfter,
  lastAssistantId,
};

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

function buildAutonomousPrompt(title: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `Autonomous task: ${title}\n\nWork on this task and report back when done. Use task_update to mark progress.`;
  }
  return `Autonomous task: ${title}\n\n${trimmed}\n\nWork on this task and report back when done. Use task_update to mark progress.`;
}

/**
 * Agent — thin wrapper around `streamText` that owns prompt assembly,
 * tool resolution, and the per-session system-prompt cache.
 *
 * The host (HTTP route or CLI) drives the actual stream:
 * - Server wraps `runStream` inside a `createUIMessageStream` writer
 *   and merges `result.toUIMessageStream()`.
 * - CLI consumes `result.fullStream` directly and assembles a
 *   UIMessage from `result.response.messages`.
 *
 * Persistence happens at the host: only the new user message + the
 * assistant response are written per turn (the prior history was
 * already in the DB and was just sent back to us). Reactive
 * compression (413 retry) is deferred — see plan.
 */
export class Agent {
  readonly config: AgentConfig;
  readonly sessionStore: SessionStore;
  readonly messageStore: MessageStore;
  readonly toolRegistry: ToolRegistry;
  readonly attachmentsRoot: string;
  readonly memoryStore: MemoryStore;
  readonly taskStore: TaskStore;
  readonly compressor = new Compressor();
  private cachedSystemPrompts = new Map<string, string>();
  // Per-session extraction cursor — the id of the last assistant message
  // an extractor run "covered." Lets `fireExtractor` skip work when no
  // new content has been added since the last successful run, and lets
  // it count newMessageCount accurately for the prompt.
  private extractionCursor = new Map<string, string>();
  // Per-session in-progress guard. Drops re-entrant fires while a run is
  // already underway — avoids 5 parallel forks when 5 turns happen in
  // quick succession against one session.
  private extractionInProgress = new Set<string>();

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
    }
  ) {
    this.config = config;
    this.sessionStore = deps.sessionStore;
    this.messageStore = deps.messageStore;
    this.toolRegistry = deps.toolRegistry;
    this.attachmentsRoot = deps.attachmentsRoot;
    this.memoryStore = deps.memoryStore;
    this.taskStore = deps.taskStore;
  }

  /**
   * Kick off one streamText call against the supplied UIMessage history.
   * Returns the streamText result; the caller drives the stream.
   *
   * `history` MUST already include the user's new turn — the SDK runs
   * one round of model + tool dispatch starting from this list.
   */
  async runStream(opts: {
    sessionId: string;
    history: UIMessage[];
    signal?: AbortSignal;
    /** Override the agentic step cap for this call. Defaults to
     *  `stepCountIs(this.config.maxSteps)`. Used by forks (extractor,
     *  future side-quest) that want a tighter ceiling. */
    stopWhen?: Parameters<typeof streamText>[0]["stopWhen"];
    /** Restrict the agent's effective tool set for THIS call to the
     *  intersection with `config.tools`. Used by forks: the extractor
     *  needs only `memory`; allowing shell/web/edit on a fire-and-
     *  forget background agent is unsupervised cost + safety risk.
     *  When omitted, all of `config.tools` are available. */
    toolFilter?: ReadonlySet<string>;
    /** Override telemetry `functionId` for dev-only Logfire dashboards.
     *  Defaults to `this.config.id`. Forked subagents pass a tag like
     *  `${id}:subagent.forked.extractor` so subagent usage is split
     *  from main-turn usage. No-op unless `OPENACME_TELEMETRY=1`. */
    telemetryFunctionId?: string;
  }): Promise<StreamTextResult<ToolSet, never>> {
    const effectiveToolNames = opts.toolFilter
      ? this.config.tools.filter((t) => opts.toolFilter!.has(t))
      : this.config.tools;
    const tools = this.toolRegistry.getVercelTools(
      new Set(effectiveToolNames)
    );

    // Make the active session+agent ids visible to tool handlers via
    // AsyncLocalStorage. `enterWith` is the right primitive here: it
    // sets the store for the rest of this async path without needing
    // a callback wrapper. `session_search` reads sessionId; `memory`
    // reads agentId to locate the per-agent MEMORY.md.
    toolCallContext.enterWith({
      sessionId: opts.sessionId,
      agentId: this.config.id,
    });

    // Recall context (when present) flows through `data-recall-context`
    // parts on the user UIMessage — `uiToModelMessages` materializes them
    // into leading text parts. No separate per-turn injection here.
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
      experimental_telemetry: {
        isEnabled: true,
        functionId: opts.telemetryFunctionId ?? this.config.id,
        metadata: { sessionId: opts.sessionId },
      },
    });
  }

  /**
   * For native Anthropic, fold the system string into messages so we can
   * attach `providerOptions.anthropic.cacheControl` and apply system_and_3
   * breakpoints. OpenRouter Claude is handled at the fetch layer in
   * llm-provider; here it's a no-op. Other providers pass through.
   */
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
    taskId: string;
    signal?: AbortSignal;
  }): Promise<{ assistant: UIMessage; usage?: TokenUsage }> {
    const task = this.taskStore.get(opts.taskId);
    if (!task) {
      throw new TaskStoreError(
        "not_found",
        `Task ${opts.taskId} not found`
      );
    }
    // Catch a deleted-mid-flight session up front rather than letting
    // the message-store FK trip mid-turn. The scheduler creates the
    // session in its tick before calling here, so this is purely a
    // guard against concurrent deletion.
    if (!this.sessionStore.get(opts.sessionId)) {
      throw new Error(
        `Session ${opts.sessionId} no longer exists; aborting autonomous turn for task ${opts.taskId}`
      );
    }

    const userMessage: UIMessage = {
      id: randomUUID(),
      role: "user",
      parts: [
        {
          type: "text",
          text: buildAutonomousPrompt(task.title, task.body),
        },
      ],
    };

    const history = [
      ...(sanitizeStoredHistory(
        this.messageStore.getHistory(opts.sessionId)
      ) as unknown as UIMessage[]),
      userMessage,
    ];

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

    // Phase-2 recall — fires identically to the chat route. Trigger
    // source is opaque to recall, so an autonomous task wakeup gets
    // the same memory surfacing as a user message.
    const recall = await this.applyMemoryRecall({
      history,
      signal: timeoutAbort.signal,
      triggerText: task.title,
    }).catch(() => ({ entries: [], modelContent: null }));

    // Attach `data-relevant-memory` to the synthesized user message —
    // serves the chip render, the alreadySurfaced dedup on subsequent
    // turns, AND the model-context materialization (uiToModelMessages
    // prepends `modelContent` as a leading text part). Persistence
    // makes the bytes byte-stable across turns → prefix cache hits.
    const recallPart = this.buildRelevantMemoryPart(
      recall.entries,
      recall.modelContent
    );
    if (recallPart) {
      userMessage.parts = [
        ...(userMessage.parts as UIMessage["parts"]),
        recallPart as unknown as UIMessage["parts"][number],
      ];
    }

    try {
      const result = await this.runStream({
        sessionId: opts.sessionId,
        history,
        signal: timeoutAbort.signal,
      });

      // Use the SDK's canonical UIMessage assembler — hand-rolling from
      // `fullStream` skips step boundaries that downstream conversion
      // relies on.
      const uiStream = result.toUIMessageStream({ sendStart: false });
      for await (const m of readUIMessageStream<UIMessage>({
        stream: uiStream,
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
        `Autonomous turn for ${opts.taskId} timed out after ${timeoutMs}ms`
      );
    }
    if (!assistantMessage) {
      throw new Error(
        `Autonomous turn for ${opts.taskId} produced no assistant message`
      );
    }

    // User message persists with the data-relevant-memory part already
    // appended above (carries entries + modelContent). No assistant-side
    // weaving needed — chip + model context both flow from the user msg.
    this.messageStore.append(opts.sessionId, {
      id: userMessage.id,
      role: "user",
      parts: userMessage.parts as unknown[],
    });
    const assistantParts = assistantMessage.parts as UIMessage["parts"];
    if (assistantParts.length > 0) {
      const sanitized = ensureStepBoundaries(
        finalizeOrphanToolParts(assistantParts)
      );
      this.messageStore.append(opts.sessionId, {
        id: assistantMessage.id ?? randomUUID(),
        role: "assistant",
        parts: sanitized as unknown[],
      });
      // Phase-3 extractor — same trigger-source-opaque wiring as chat.
      // Cursor + in-progress guard live on Agent so a long-running
      // autonomous task that wakes 5x fast doesn't fork 5 extractors.
      const stored = this.messageStore.getHistory(opts.sessionId);
      this.fireExtractor({
        sessionId: opts.sessionId,
        sessionMessages: stored as unknown as UIMessage[],
      });
    }

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
      console.error(
        `Failed to persist compressed messages for ${child.id}: ${e instanceof Error ? e.message : String(e)}`
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
        console.error(
          `Compression: failed to copy ${srcAbs} → ${dstAbs}: ${
            e instanceof Error ? e.message : String(e)
          }`
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
      console.warn(
        `Pre-compaction memory flush failed for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`
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
      console.warn(
        `Agent '${this.config.id}': Missing tools: ${missingTools.join(", ")}`
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
        this.config.memoryCharLimit
      );
    } catch (e) {
      console.warn(
        `Failed to read memory index for agent ${this.config.id}: ${e instanceof Error ? e.message : String(e)}`
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
      console.warn(
        `Failed to render tasks for agent ${this.config.id}: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    const prompt = buildSystemPrompt({
      persona: this.config.persona,
      toolNames: resolvedTools,
      skillsIndex: this.config.skillsIndex,
      tasksContext,
      memorySnapshot,
    });
    this.cachedSystemPrompts.set(sessionId, prompt);

    try {
      this.sessionStore.updateSystemPrompt(sessionId, prompt);
    } catch (e) {
      console.error(
        `Failed to update system prompt: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return prompt;
  }

  /**
   * Recall pass: scan `<agentDir>/memory/` for entries relevant to the
   * incoming work-item and return them ready for surfacing.
   *
   * Caller is responsible for both halves of the surfacing:
   *   1. Emit a persistent `data-relevant-memory` part on the assistant
   *      message containing `entries` — UI chip + the next turn's
   *      surfaced-set dedup key.
   *   2. Append `buildRecallContextPart(modelContent)` to the user
   *      UIMessage's parts BEFORE passing to `runStream` and BEFORE
   *      persisting. `uiToModelMessages` materializes that part into a
   *      leading `<system-reminder>` text part on every turn that loads
   *      the message — so the recall reaches the model now AND on
   *      subsequent turns with byte-stable bytes (prefix cache hits).
   *
   * Bytes baked at recall time (freshness "N days ago" frozen) so
   * subsequent turns send identical content. Without this, recomputing
   * the freshness string per turn would invalidate the cache from this
   * user message onward.
   *
   * The recall-context part lands on the user message — NOT the system
   * prompt — which keeps the system bit-identical and preserves
   * provider-side prefix caching (Anthropic native, OpenRouter Claude,
   * OpenAI automatic).
   *
   * No-op (returns empty `entries` + null `modelContent`) when:
   *   - There's no usable trigger text in `history`
   *   - Memory dir is empty / unreadable
   *   - The selector returns zero relevant entries
   *   - All relevant entries were already surfaced this session
   *   - The selector model errors (e.g. provider doesn't support
   *     structured output — Ollama small models, etc)
   *
   * Failure modes are silent — recall is advisory and must never fail
   * the parent turn.
   *
   * Trigger source is opaque: `triggerText` is whatever brought the
   * agent in. Defaults to the last text part of `history` (chat /
   * autonomous task prompts both flow through that); peers / cron
   * trigger paths can pass it explicitly.
   */
  async applyMemoryRecall(opts: {
    history: UIMessage[];
    signal?: AbortSignal;
    /** Optional override for the trigger description. Falls back to the
     *  last text part of `history` — fine for chat, will be replaced by
     *  task/peer/cron payloads in the autonomous path. */
    triggerText?: string;
    /** Tool names the agent has invoked recently — used by the selector
     *  to suppress reference-doc hits for active tools. */
    recentTools?: readonly string[];
  }): Promise<{
    entries: Array<{ path: string; mtimeMs: number; content: string }>;
    /** Pre-rendered `<system-reminder>` block destined for the model's
     *  view of the user message. Stored verbatim on the user message
     *  as a `data-recall-context` part — `uiToModelMessages` materializes
     *  it back as a leading text part on every load. Bytes are baked at
     *  recall time (freshness "N days ago" frozen in) so subsequent
     *  turns send byte-identical content → prefix cache hits.
     *
     *  Null when nothing was selected. */
    modelContent: string | null;
  }> {
    const triggerText = opts.triggerText ?? extractTriggerText(opts.history);
    if (!triggerText || triggerText.trim().length === 0) {
      return { entries: [], modelContent: null };
    }

    const memoryDir = this.memoryStore.dirPath(this.config.id);
    const surfaced = collectSurfacedMemories(opts.history);

    // CC parity: stop surfacing once cumulative bytes hit the session
    // cap. Past this point the most-relevant entries are already in
    // context; continuing to surface dilutes attention. Compaction
    // resets this naturally (old attachments are gone post-compact).
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
      console.warn(
        `[memory.recall] agent=${this.config.id}: ${e instanceof Error ? e.message : String(e)}`
      );
      return { entries: [], modelContent: null };
    }

    if (selected.length === 0) {
      return { entries: [], modelContent: null };
    }

    const entries: Array<{ path: string; mtimeMs: number; content: string }> = [];
    for (const r of selected) {
      try {
        const body = fs.readFileSync(r.path, "utf-8");
        entries.push({ path: r.path, mtimeMs: r.mtimeMs, content: body });
      } catch {
        // File vanished between scan and read — skip silently.
      }
    }

    if (entries.length === 0) {
      return { entries: [], modelContent: null };
    }

    // CC's natural-language format (`utils/attachments.ts:2329`
    // memoryHeader + `messages.ts:3710` per-memory wrapping). Each
    // entry is its own `<system-reminder>` block. Bytes baked HERE,
    // once, at recall time — caller persists this string verbatim and
    // it's replayed on every subsequent turn (prefix cache stable).
    //
    // Header form:
    //   fresh:  Memory (saved {today|yesterday|N days ago}): {path}:
    //   stale:  {staleness sentence}\n\nMemory: {path}:
    //
    // We use the agent's logical `/memories/<rel>` path — semantically
    // equivalent to CC's absolute filesystem path while not leaking
    // the user's home directory.
    const blocks = entries.map((e) => {
      const rel = path.relative(memoryDir, e.path);
      const logicalPath = `/memories/${rel}`;
      const staleness = memoryFreshnessText(e.mtimeMs);
      const header = staleness
        ? `${staleness}\n\nMemory: ${logicalPath}:`
        : `Memory (saved ${memoryAge(e.mtimeMs)}): ${logicalPath}:`;
      return `<system-reminder>\n${header}\n\n${e.content}\n</system-reminder>`;
    });
    const modelContent = blocks.join("\n\n");

    return { entries, modelContent };
  }

  /**
   * Helper for callers: builds the `data-relevant-memory` part to
   * attach to the user UIMessage. Carries both `entries` (for the UI
   * chip + alreadySurfaced dedup) and `modelContent` (the pre-rendered
   * model-input bytes that `uiToModelMessages` materializes). Returns
   * `null` when there's no recall to persist.
   */
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
   * Schedule the post-turn memory extractor (Phase 3) for this session.
   * Fire-and-forget: returns immediately, the run lives on as a void
   * promise. Internally guards against:
   *   - Re-entrant fires while a run is already in progress (drops the
   *     incoming fire — next turn's fire picks up the latest content).
   *   - No-new-content cases (cursor is at or past the last assistant
   *     message — nothing to extract).
   *   - Main-agent-already-wrote (the extractor's own skip path —
   *     advances the cursor past this range so we don't re-evaluate).
   *
   * Cursor advances on completed / skipped-* outcomes; stays put on
   * failed / aborted / timeout so the next fire can retry.
   *
   * Trigger source is opaque — this method is called identically from
   * the chat route's onFinish AND from `runAutonomous`'s persist step.
   */
  fireExtractor(opts: {
    sessionId: string;
    /** Full session history INCLUDING the just-finished assistant
     *  message. The extractor needs to see the latest turn. */
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
        // Advance the cursor on any non-error terminal status so we
        // don't re-evaluate the same range. Failed/aborted/timeout
        // leave the cursor put — next fire retries the same window.
        if (
          res.status === "completed" ||
          res.status === "skipped-main-wrote" ||
          res.status === "skipped-no-new-content"
        ) {
          const lastAsst = lastAssistantId(opts.sessionMessages);
          if (lastAsst) this.extractionCursor.set(opts.sessionId, lastAsst);
        }
        if (res.status === "failed") {
          console.warn(
            `[memory.extractor] agent=${this.config.id} session=${opts.sessionId}: ${res.error ?? "unknown"}`
          );
        }
      })
      .catch((e) => {
        console.warn(
          `[memory.extractor] agent=${this.config.id} session=${opts.sessionId} threw: ${e instanceof Error ? e.message : String(e)}`
        );
      })
      .finally(() => {
        this.extractionInProgress.delete(opts.sessionId);
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
