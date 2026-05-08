import { streamText, type CoreMessage } from "ai";
import { getModel } from "@openacme/llm-provider";
import type { ToolRegistry } from "@openacme/tools";
import type {
  SessionStore,
  MessageStore,
} from "@openacme/db";
import { buildSystemPrompt } from "./prompt.js";
import type { AgentConfig, StreamChunk } from "./types.js";
import { randomUUID } from "node:crypto";

/**
 * Agent — the core conversational AI engine.
 *
 * Mirrors Hermes run_agent.py AIAgent class but uses Vercel AI SDK
 * for LLM calls and tool dispatch.
 *
 * State machine: Idle → PromptAssembly → LLMCall → ToolExecution ↔ LLMCall → Response → Idle
 */
export class Agent {
  readonly config: AgentConfig;
  private readonly sessionStore: SessionStore;
  private readonly messageStore: MessageStore;
  private readonly toolRegistry: ToolRegistry;
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
   */
  async *chat(
    sessionId: string,
    userMessage: string
  ): AsyncIterable<StreamChunk> {
    // Ensure session exists. Honor the caller-supplied id so the SSE
    // `session` event the server already emitted (app.ts:145) actually
    // matches the row we persist against — without this, the client
    // pins one id while the DB row uses another, and follow-up turns
    // never load history.
    let session = this.sessionStore.get(sessionId);
    if (!session) {
      session = this.sessionStore.create(this.config.id, { id: sessionId });
    }

    // Load conversation history. Reconstruct Vercel AI SDK CoreMessage v3
    // shape: assistant messages with tool calls become content-parts arrays;
    // tool messages become role:"tool" with a tool-result part. Old rows
    // written before tool persistence existed used a different field shape
    // (`{id, name, args}`); we normalize them on read. Assistant rows whose
    // tool calls have no matching tool result in the next message are dropped
    // (the call would otherwise be unresolved and reject on most providers).
    const dbMessages = this.messageStore.getHistory(sessionId);
    const messages: CoreMessage[] = [];
    for (let i = 0; i < dbMessages.length; i++) {
      const m = dbMessages[i]!;

      if (m.role === "tool" && m.toolCallId && m.toolName) {
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: m.toolCallId,
              toolName: m.toolName,
              result: m.content ?? "",
            },
          ],
        } as unknown as CoreMessage);
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
            `Failed to parse toolCalls for message: ${e instanceof Error ? e.message : String(e)}`
          );
        }
        // Normalize legacy `{id, name, args}` → `{toolCallId, toolName, args}`.
        const normalized = parsed
          .map((tc) => ({
            toolCallId: tc.toolCallId ?? tc.id ?? "",
            toolName: tc.toolName ?? tc.name ?? "",
            args: tc.args,
          }))
          .filter((tc) => tc.toolCallId && tc.toolName);

        // Drop tool calls whose result row never followed (legacy DBs).
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
            args: tc.args,
          });
        }

        if (parts.length > 0) {
          messages.push({
            role: "assistant",
            content: parts,
          } as unknown as CoreMessage);
        }
        continue;
      }

      messages.push({
        role: m.role as "user" | "assistant" | "system",
        content: m.content ?? "",
      });
    }

    // Add user message
    messages.push({ role: "user", content: userMessage });
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
      console.error(`Failed to save user message: ${e instanceof Error ? e.message : String(e)}`);
      yield { type: "error", error: "Failed to save message to database" };
      return;
    }

    // Build system prompt (cache per session — Hermes pattern)
    let systemPrompt = this.cachedSystemPrompts.get(sessionId);
    if (!systemPrompt) {
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

      // Warn about missing tools
      if (missingTools.length > 0) {
        console.warn(`Agent '${this.config.id}': Missing tools: ${missingTools.join(", ")}`);
      }

      systemPrompt = buildSystemPrompt({
        persona: this.config.persona,
        toolNames: resolvedTools,
        skillsIndex: this.config.skillsIndex,
      });
      this.cachedSystemPrompts.set(sessionId, systemPrompt);

      // Store in session for prefix caching
      try {
        this.sessionStore.updateSystemPrompt(sessionId, systemPrompt);
      } catch (e) {
        console.error(`Failed to update system prompt: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Get LLM model
    const model = getModel(this.config.model);

    // Get tools for Vercel AI SDK
    const toolNames = new Set(this.config.tools);
    const tools = this.toolRegistry.getVercelTools(toolNames);

    // Stream the conversation
    try {
      const result = streamText({
        model,
        system: systemPrompt,
        messages,
        tools: tools as Parameters<typeof streamText>[0]["tools"],
        maxSteps: this.config.maxSteps,
      });

      let fullContent = "";

      for await (const part of result.fullStream) {
        // Hoisted out of the typed switch: `tool-result` IS in the SDK's
        // TextStreamPart union (ai 4.3 dist/index.d.ts:2848), but the
        // ToolResultUnion<TOOLS> half collapses to `never` because our
        // tools type is widened by the streamText call. Match by string
        // and re-narrow.
        if ((part as { type: string }).type === "tool-result") {
          const tr = part as unknown as {
            toolCallId: string;
            toolName: string;
            result: unknown;
          };
          yield {
            type: "tool-result",
            toolName: tr.toolName,
            toolCallId: tr.toolCallId,
            result:
              typeof tr.result === "string"
                ? tr.result
                : JSON.stringify(tr.result),
          };
          continue;
        }

        switch (part.type) {
          case "text-delta":
            fullContent += part.textDelta;
            yield { type: "text-delta", text: part.textDelta };
            break;

          case "tool-call": {
            const toolCallId = part.toolCallId ?? randomUUID();
            yield {
              type: "tool-call",
              toolName: part.toolName,
              args: part.args as Record<string, unknown>,
              toolCallId,
            };
            break;
          }

          case "error":
            yield { type: "error", error: String(part.error) };
            break;

          default:
            // text-delta, tool-call, and the hoisted tool-result branch
            // drive the live UI. step-finish, reasoning, source, finish
            // are captured via result.steps below for persistence.
            break;
        }
      }

      // Persist the full turn from the SDK's per-step view. Each step yields
      // an assistant row (text + tool calls) followed by one tool row per
      // tool result, so follow-up turns reload a valid call→result sequence.
      const usage = await result.usage;
      try {
        const steps = await result.steps;
        for (const step of steps) {
          const stepCalls = (step.toolCalls ?? []).map((tc) => ({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
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
          // The SDK types step.toolResults against the concrete tools
          // generic; with our widened tools (Vercel AI SDK Parameters cast)
          // the element type collapses to `never`. Re-narrow at the use
          // site — the runtime shape is well-defined (toolCallId, toolName,
          // result) regardless of what the type system can see.
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

      // Update session title from first message
      try {
        if (!session.title && fullContent) {
          const title = fullContent.slice(0, 80).replace(/\n/g, " ");
          this.sessionStore.updateTitle(sessionId, title);
        }

        // Touch session updated_at
        this.sessionStore.touch(sessionId);
      } catch (e) {
        console.error(`Failed to update session: ${e instanceof Error ? e.message : String(e)}`);
      }

      yield {
        type: "done",
        usage: usage
          ? {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }
          : undefined,
      };
    } catch (error) {
      yield {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get conversation history for a session.
   */
  getHistory(sessionId: string) {
    return this.messageStore.getHistory(sessionId);
  }

  /**
   * Invalidate the cached system prompt for a session.
   * Call this when agent config (tools, skills) changes.
   */
  invalidateSystemPromptCache(sessionId?: string): void {
    if (sessionId) {
      this.cachedSystemPrompts.delete(sessionId);
    } else {
      this.cachedSystemPrompts.clear();
    }
  }
}
