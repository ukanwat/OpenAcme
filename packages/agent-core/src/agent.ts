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
import { MemoryStore } from "@openacme/memory";
import { TaskStore, TaskStoreError } from "@openacme/tasks";
import type { SessionStore, MessageStore, StoredUIMessage } from "@openacme/db";
import { buildSystemPrompt } from "./prompt.js";
import { Compressor } from "./compression.js";
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
  }): Promise<StreamTextResult<ToolSet, never>> {
    const tools = this.toolRegistry.getVercelTools(
      new Set(this.config.tools)
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
      stopWhen: stepCountIs(this.config.maxSteps),
      abortSignal: opts.signal,
      experimental_telemetry: {
        isEnabled: true,
        functionId: this.config.id,
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

    this.messageStore.append(opts.sessionId, {
      id: userMessage.id,
      role: "user",
      parts: userMessage.parts as unknown[],
    });
    if (assistantMessage.parts.length > 0) {
      const sanitized = ensureStepBoundaries(
        finalizeOrphanToolParts(assistantMessage.parts as UIMessage["parts"])
      );
      this.messageStore.append(opts.sessionId, {
        id: assistantMessage.id ?? randomUUID(),
        role: "assistant",
        parts: sanitized as unknown[],
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
    let memoryContext: string | undefined;
    try {
      const rendered = this.memoryStore.renderForPrompt(
        this.config.id,
        this.config.memoryCharLimit
      );
      if (rendered) memoryContext = rendered;
    } catch (e) {
      console.warn(
        `Failed to render MEMORY.md for agent ${this.config.id}: ${e instanceof Error ? e.message : String(e)}`
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
      memoryContext,
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
