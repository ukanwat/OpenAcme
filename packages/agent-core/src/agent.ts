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

function buildAutonomousPrompt(title: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `Autonomous task: ${title}\n\nWork on this task and report back when done. Use task_update to mark progress.`;
  }
  return `Autonomous task: ${title}\n\n${trimmed}\n\nWork on this task and report back when done. Use task_update to mark progress.`;
}

/**
 * Owns prompt assembly, tool resolution, the per-session prompt cache,
 * and the recall/extractor lifecycle. Host (HTTP route or CLI) drives
 * the stream and persistence.
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
  // Cursor: id of the last assistant covered by an extractor run.
  private extractionCursor = new Map<string, string>();
  // Coalesces re-entrant fires (fast successive turns → one fork).
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
  }): Promise<StreamTextResult<ToolSet, never>> {
    const effectiveToolNames = opts.toolFilter
      ? this.config.tools.filter((t) => opts.toolFilter!.has(t))
      : this.config.tools;
    const tools = this.toolRegistry.getVercelTools(
      new Set(effectiveToolNames)
    );

    // ALS: tool handlers read sessionId/agentId without arg-threading.
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
      stopWhen: opts.stopWhen ?? stepCountIs(this.config.maxSteps),
      abortSignal: opts.signal,
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
    // Guard against concurrent session deletion (scheduler created it
    // in its tick; could vanish before we run).
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

    const recall = await this.applyMemoryRecall({
      history,
      signal: timeoutAbort.signal,
      triggerText: task.title,
    }).catch(() => ({ entries: [], modelContent: null }));

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

      // Hand-rolling from `fullStream` skips step boundaries that
      // downstream conversion relies on — use the SDK assembler.
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
        const rel = path.relative(memoryDir, r.path);
        const content = truncateForSurfacing(body, `/memories/${rel}`);
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
