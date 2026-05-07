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
    // Ensure session exists
    let session = this.sessionStore.get(sessionId);
    if (!session) {
      session = this.sessionStore.create(this.config.id);
      sessionId = session.id;
    }

    // Load conversation history
    const dbMessages = this.messageStore.getHistory(sessionId);
    const messages: CoreMessage[] = dbMessages.map((m) => {
      if (m.role === "tool" && m.toolCallId) {
        return {
          role: "tool" as const,
          content: m.content ?? "",
          toolCallId: m.toolCallId,
        } as unknown as CoreMessage;
      }
      if (m.role === "assistant" && m.toolCalls) {
        let parsedToolCalls: unknown[] = [];
        try {
          parsedToolCalls = JSON.parse(m.toolCalls);
        } catch (e) {
          console.warn(`Failed to parse toolCalls for message: ${e instanceof Error ? e.message : String(e)}`);
        }
        return {
          role: "assistant" as const,
          content: m.content ?? "",
          toolCalls: parsedToolCalls,
        } as unknown as CoreMessage;
      }
      return {
        role: m.role as "user" | "assistant" | "system",
        content: m.content ?? "",
      };
    });

    // Add user message
    messages.push({ role: "user", content: userMessage });
    try {
      this.messageStore.append(sessionId, {
        sessionId,
        role: "user",
        content: userMessage,
        toolCalls: null,
        toolCallId: null,
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
      const toolCallsForDb: Array<{
        id: string;
        name: string;
        args: unknown;
      }> = [];

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            fullContent += part.textDelta;
            yield { type: "text-delta", text: part.textDelta };
            break;

          case "tool-call": {
            const toolCallId = part.toolCallId ?? randomUUID();
            toolCallsForDb.push({
              id: toolCallId,
              name: part.toolName,
              args: part.args,
            });
            yield {
              type: "tool-call",
              toolName: part.toolName,
              args: part.args as Record<string, unknown>,
              toolCallId,
            };
            break;
          }

          case "step-finish": {
            // Step finish may contain tool results from the previous step
            // The Vercel AI SDK handles tool execution and feeds results
            // back to the model automatically via maxSteps.
            break;
          }

          case "error":
            yield { type: "error", error: String(part.error) };
            break;

          default:
            // Other events: reasoning, source, finish, etc. — skip
            break;
        }
      }

      // Save assistant message
      const usage = await result.usage;
      try {
        this.messageStore.append(sessionId, {
          sessionId,
          role: "assistant",
          content: fullContent || null,
          toolCalls:
            toolCallsForDb.length > 0
              ? JSON.stringify(toolCallsForDb)
              : null,
          toolCallId: null,
        });
      } catch (e) {
        console.error(`Failed to save assistant message: ${e instanceof Error ? e.message : String(e)}`);
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
