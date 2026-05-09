import {
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
import type { SessionStore, MessageStore, StoredUIMessage } from "@openacme/db";
import { buildSystemPrompt } from "./prompt.js";
import { Compressor } from "./compression.js";
import { uiToModelMessages, parseAttachmentUrl } from "./messages.js";
import type { AgentConfig } from "./types.js";

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
  readonly compressor = new Compressor();
  private cachedSystemPrompts = new Map<string, string>();

  constructor(
    config: AgentConfig,
    deps: {
      sessionStore: SessionStore;
      messageStore: MessageStore;
      toolRegistry: ToolRegistry;
      attachmentsRoot: string;
    }
  ) {
    this.config = config;
    this.sessionStore = deps.sessionStore;
    this.messageStore = deps.messageStore;
    this.toolRegistry = deps.toolRegistry;
    this.attachmentsRoot = deps.attachmentsRoot;
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

    // Make the active session id visible to tool handlers via
    // AsyncLocalStorage. `enterWith` is the right primitive here: it
    // sets the store for the rest of this async path without needing
    // a callback wrapper.
    toolCallContext.enterWith({ sessionId: opts.sessionId });

    const messages = await uiToModelMessages(opts.history, {
      attachmentsRoot: this.attachmentsRoot,
      tools: tools as ToolSet,
    });

    return streamText({
      model: getModel(this.config.model),
      system: this.getSystemPrompt(opts.sessionId),
      messages,
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

    const parentMessages = this.messageStore.getHistory(
      parentSessionId
    ) as unknown as UIMessage[];
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
      const rows: StoredUIMessage[] = rebound.map((m) => ({
        id: randomUUID(),
        role: m.role as "user" | "assistant",
        parts: m.parts as unknown[],
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
