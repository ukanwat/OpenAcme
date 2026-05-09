import { streamText, stepCountIs, type ModelMessage } from "ai";
import { getModel } from "@openacme/llm-provider";
import { toolCallContext, type ToolRegistry } from "@openacme/tools";
import type { SessionStore, MessageStore, Message } from "@openacme/db";
import { buildSystemPrompt } from "./prompt.js";
import { Compressor, resolveThreshold } from "./compression.js";
import { classifyError } from "./error-classifier.js";
import type { AgentConfig, StreamChunk } from "./types.js";
import { randomUUID } from "node:crypto";

/**
 * Agent — the core conversational AI engine.
 *
 * Uses Vercel AI SDK for LLM calls + tool dispatch. Compression follows
 * Hermes's runtime ContextCompressor: synchronous-at-end-of-turn for
 * proactive triggers, plus a reactive retry loop in `chat()` that catches
 * provider 413 / context_overflow errors, runs compression, and retries
 * the same turn against the new (compressed) child session.
 *
 * State machine: Idle → PromptAssembly → LLMCall → ToolExecution ↔ LLMCall → Response → Idle
 */
export class Agent {
  readonly config: AgentConfig;
  private readonly sessionStore: SessionStore;
  private readonly messageStore: MessageStore;
  private readonly toolRegistry: ToolRegistry;
  private readonly compressor = new Compressor();
  private cachedSystemPrompts = new Map<string, string>();

  constructor(
    config: AgentConfig,
    deps: {
      sessionStore: SessionStore;
      messageStore: MessageStore;
      toolRegistry: ToolRegistry;
    }
  ) {
    this.config = config;
    this.sessionStore = deps.sessionStore;
    this.messageStore = deps.messageStore;
    this.toolRegistry = deps.toolRegistry;
  }

  /**
   * Main conversation method — sends a message and returns an async iterable
   * of StreamChunks for real-time streaming.
   *
   * Two-attempt loop. Attempt 1: append user message, stream, persist.
   * If a stream-stopping error matches the classifier (413 / context_overflow),
   * run reactive compression, swap to the child session, retry once. On
   * success, run proactive compression check before yielding `done`.
   */
  async *chat(
    sessionId: string,
    userMessage: string,
    opts?: { signal?: AbortSignal }
  ): AsyncIterable<StreamChunk> {
    // Pre-flight cancel: caller already aborted (e.g. user double-clicked
    // stop, or fetch was cancelled before reaching the route). Skip
    // persisting the user message — they didn't actually commit to it.
    if (opts?.signal?.aborted) {
      yield { type: "stopped" };
      return;
    }

    // Ensure session exists. Honor caller-supplied id so the SSE `session`
    // event the server pre-emitted matches the row we persist against.
    let session = this.sessionStore.get(sessionId);
    if (!session) {
      session = this.sessionStore.create(this.config.id, { id: sessionId });
    }

    // Persist user message ONCE — reactive retry doesn't re-append because
    // a fork copies the latest user message into the child's tail.
    try {
      this.messageStore.append(sessionId, {
        sessionId,
        role: "user",
        content: userMessage,
        toolCalls: null,
        toolCallId: null,
        toolName: null,
      });
    } catch (e) {
      console.error(
        `Failed to save user message: ${e instanceof Error ? e.message : String(e)}`
      );
      yield { type: "error", error: "Failed to save message to database" };
      return;
    }

    const systemPrompt = this.getSystemPrompt(sessionId);
    const tools = this.toolRegistry.getVercelTools(new Set(this.config.tools));

    for (let attempt = 1; attempt <= 2; attempt++) {
      const dbMessages = this.messageStore.getHistory(sessionId);
      const messages = this.buildCoreMessages(dbMessages);

      let fullContent = "";
      let recoverableError: unknown = null;

      // Make the active session id visible to tool handlers via
      // AsyncLocalStorage. `enterWith` is the right primitive for an async
      // generator: it sets the store for the rest of this async path
      // without requiring a callback wrapper that would conflict with
      // `yield`. Reactive retry on attempt 2 re-enters with the swapped
      // (child) sessionId, which is what `session_search` should see.
      toolCallContext.enterWith({ sessionId });

      try {
        const result = streamText({
          model: getModel(this.config.model),
          system: systemPrompt,
          messages,
          tools: tools as Parameters<typeof streamText>[0]["tools"],
          stopWhen: stepCountIs(this.config.maxSteps),
          abortSignal: opts?.signal,
          experimental_telemetry: {
            isEnabled: true,
            functionId: this.config.id,
            metadata: { sessionId, attempt },
          },
        });

        for await (const part of result.fullStream) {
          // `tool-result` IS in TextStreamPart's union but the typed branch
          // collapses to `never` because we widen tools. Match by string.
          if ((part as { type: string }).type === "tool-result") {
            const tr = part as unknown as {
              toolCallId: string;
              toolName: string;
              output: unknown;
            };
            yield {
              type: "tool-result",
              toolName: tr.toolName,
              toolCallId: tr.toolCallId,
              result:
                typeof tr.output === "string"
                  ? tr.output
                  : JSON.stringify(tr.output),
            };
            continue;
          }

          switch (part.type) {
            case "text-delta":
              fullContent += part.text;
              yield { type: "text-delta", text: part.text };
              break;
            case "tool-call": {
              const toolCallId = part.toolCallId ?? randomUUID();
              yield {
                type: "tool-call",
                toolName: part.toolName,
                args: part.input as Record<string, unknown>,
                toolCallId,
              };
              break;
            }
            case "error":
              // Stream-emitted error part. Re-throw so the same classifier
              // path handles both this and stream-stopping errors uniformly.
              throw part.error;
            default:
              // start, start-step, finish-step, finish, tool-input-start/delta/end,
              // tool-error, reasoning-*, source, file, raw — all ignored.
              break;
          }
        }

        // Awaiting these AFTER a clean fullStream loop is safe; if the
        // stream errored, we never reach here.
        const usage = await result.usage;
        const steps = await result.steps;

        this.persistAssistantTurn(sessionId, steps);

        // Title from first response.
        try {
          if (!session.title && fullContent) {
            const title = fullContent.slice(0, 80).replace(/\n/g, " ");
            this.sessionStore.updateTitle(sessionId, title);
          }
          this.sessionStore.touch(sessionId);
        } catch (e) {
          console.error(
            `Failed to update session: ${e instanceof Error ? e.message : String(e)}`
          );
        }

        // Proactive compression: synchronous, end-of-turn.
        const threshold = this.config.compression
          ? resolveThreshold(this.config.compression)
          : null;
        if (
          threshold !== null &&
          usage &&
          typeof usage.inputTokens === "number" &&
          this.compressor.shouldCompress(sessionId, usage.inputTokens, threshold)
        ) {
          const childId = await this.compress(sessionId, "proactive");
          if (childId !== sessionId) {
            yield { type: "session", sessionId: childId };
            sessionId = childId;
          }
        }

        yield {
          type: "done",
          usage: usage
            ? {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
              }
            : undefined,
        };
        return;
      } catch (err) {
        recoverableError = err;
      }

      // User cancel — exit cleanly without classifying or compressing.
      // Partial assistant output (text/tool calls already streamed to the
      // client) is intentionally not persisted on cancel: `result.steps`
      // isn't reliably finalized after an aborted stream, and the user
      // message stays in history so a retry just works.
      if (
        opts?.signal?.aborted ||
        (recoverableError instanceof Error &&
          recoverableError.name === "AbortError")
      ) {
        yield { type: "stopped" };
        return;
      }

      // Reactive recovery path — only attempts 1 may compress + retry.
      if (attempt === 1) {
        const classified = classifyError(recoverableError);
        if (classified.compressionReason) {
          try {
            const childId = await this.compress(sessionId, classified.compressionReason);
            if (childId !== sessionId) {
              yield { type: "session", sessionId: childId };
              sessionId = childId;
              const refreshed = this.sessionStore.get(childId);
              if (refreshed) session = refreshed;
              continue; // retry attempt 2 against child history
            }
          } catch (compressErr) {
            console.error(
              `Reactive compression failed for ${sessionId}: ${compressErr instanceof Error ? compressErr.message : String(compressErr)}`
            );
          }
        }
      }

      // Fall through: surface the error and stop.
      yield {
        type: "error",
        error:
          recoverableError instanceof Error
            ? recoverableError.message
            : String(recoverableError),
      };
      return;
    }
  }

  /**
   * Compress a session synchronously. Loads parent history, runs the
   * Compressor pipeline (pre-prune → boundary → summarize → sanitize),
   * creates a child session, and persists the new message list. Returns
   * the new child id, or the parent id if compression was a no-op.
   */
  async compress(
    parentSessionId: string,
    reason: "proactive" | "payload_too_large" | "context_overflow"
  ): Promise<string> {
    const parent = this.sessionStore.get(parentSessionId);
    if (!parent) return parentSessionId;

    // Cross-process race: another writer may have forked this parent
    // already (separate AgentManager on the same db).
    const existingChild = this.sessionStore.findChildOf(parentSessionId);
    if (existingChild) {
      this.compressor.inheritState(parentSessionId, existingChild.id);
      return existingChild.id;
    }

    if (!this.config.compression) return parentSessionId;

    const parentMessages = this.messageStore.getHistory(parentSessionId);
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
      // Race-loser: another writer beat us. Use the winning child.
      const won = this.sessionStore.findChildOf(parentSessionId);
      if (won) {
        this.compressor.inheritState(parentSessionId, won.id);
        return won.id;
      }
      return parentSessionId;
    }

    try {
      const rows: Array<Omit<Message, "id" | "createdAt">> =
        result.childMessages.map((m) => ({
          sessionId: child.id,
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
          toolCallId: m.toolCallId,
          toolName: m.toolName,
        }));
      this.messageStore.appendMany(child.id, rows);
    } catch (e) {
      console.error(
        `Failed to persist compressed messages for ${child.id}: ${e instanceof Error ? e.message : String(e)}`
      );
      // Child row exists but its messages failed to persist. Caller will
      // see an empty child and likely fail subsequent turns; surface the
      // problem rather than silently swap.
      throw e;
    }

    this.compressor.inheritState(parentSessionId, child.id);
    this.compressor.recordResult(child.id, result.savingsRatio, result.summary);
    // The parent's system-prompt cache entry is dead now (parent is hidden
    // by `listActive`). Drop it so the Map doesn't accumulate one entry
    // per compression on long-lived agents.
    this.cachedSystemPrompts.delete(parentSessionId);
    return child.id;
  }

  /**
   * Build CoreMessages from DB rows. Reconstructs Vercel AI SDK shape:
   * assistant messages with tool calls become content-parts arrays;
   * tool messages become role:"tool" with a tool-result part. Drops
   * orphan tool calls (legacy DBs) by checking the next row.
   */
  private buildCoreMessages(dbMessages: Message[]): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (let i = 0; i < dbMessages.length; i++) {
      const m = dbMessages[i]!;

      if (m.role === "tool" && m.toolCallId && m.toolName) {
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: m.toolCallId,
              toolName: m.toolName,
              output: { type: "text", value: m.content ?? "" },
            },
          ],
        } as unknown as ModelMessage);
        continue;
      }

      if (m.role === "assistant" && m.toolCalls) {
        let parsed: Array<{
          id?: string;
          name?: string;
          toolCallId?: string;
          toolName?: string;
          args: unknown;
        }> = [];
        try {
          parsed = JSON.parse(m.toolCalls);
        } catch (e) {
          console.warn(
            `Failed to parse toolCalls: ${e instanceof Error ? e.message : String(e)}`
          );
        }
        const normalized = parsed
          .map((tc) => ({
            toolCallId: tc.toolCallId ?? tc.id ?? "",
            toolName: tc.toolName ?? tc.name ?? "",
            args: tc.args,
          }))
          .filter((tc) => tc.toolCallId && tc.toolName);

        const next = dbMessages[i + 1];
        const hasFollowingToolMessage =
          next?.role === "tool" && next.toolCallId !== null;
        const callsToInclude = hasFollowingToolMessage ? normalized : [];

        const parts: unknown[] = [];
        if (m.content) parts.push({ type: "text", text: m.content });
        for (const tc of callsToInclude) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.args,
          });
        }

        if (parts.length > 0) {
          out.push({
            role: "assistant",
            content: parts,
          } as unknown as ModelMessage);
        }
        continue;
      }

      out.push({
        role: m.role as "user" | "assistant" | "system",
        content: m.content ?? "",
      });
    }
    return out;
  }

  private persistAssistantTurn(
    sessionId: string,
    steps: ReadonlyArray<{
      readonly text?: string;
      readonly toolCalls?: ReadonlyArray<{ toolCallId: string; toolName: string; input?: unknown }>;
      readonly toolResults?: unknown;
    }>
  ): void {
    try {
      for (const step of steps) {
        const stepCalls = (step.toolCalls ?? []).map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.input,
        }));
        const stepText = step.text ?? "";
        const hasContent = stepText.length > 0 || stepCalls.length > 0;
        if (hasContent) {
          this.messageStore.append(sessionId, {
            sessionId,
            role: "assistant",
            content: stepText || null,
            toolCalls:
              stepCalls.length > 0 ? JSON.stringify(stepCalls) : null,
            toolCallId: null,
            toolName: null,
          });
        }
        const toolResults = (step.toolResults ?? []) as Array<{
          toolCallId: string;
          toolName: string;
          result: unknown;
        }>;
        for (const tr of toolResults) {
          const resultText =
            typeof tr.result === "string"
              ? tr.result
              : JSON.stringify(tr.result);
          this.messageStore.append(sessionId, {
            sessionId,
            role: "tool",
            content: resultText,
            toolCalls: null,
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
          });
        }
      }
    } catch (e) {
      console.error(
        `Failed to persist assistant turn: ${e instanceof Error ? e.message : String(e)}`
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

    const prompt = buildSystemPrompt({
      persona: this.config.persona,
      toolNames: resolvedTools,
      skillsIndex: this.config.skillsIndex,
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

  /** Get conversation history for a session. */
  getHistory(sessionId: string) {
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
