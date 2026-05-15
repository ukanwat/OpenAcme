/**
 * Subagent primitive. Two modes:
 *   forked     — multi-turn loop sharing the parent's prompt + tools
 *                (optional toolFilter). Used by the extractor.
 *   structured — one-shot generateObject with custom system + JSON
 *                schema. Used by the recall selector.
 * Both bound execution via timeoutMs + abortSignal, never throw,
 * return a discriminated `SubagentStatus`. Telemetry tags split
 * subagent vs main-turn usage when OPENACME_TELEMETRY=1.
 */

import {
  generateObject,
  readUIMessageStream,
  stepCountIs,
  type StopCondition,
  type ToolSet,
  type UIMessage,
} from "ai";
import { randomUUID } from "node:crypto";
import { z, type ZodTypeAny } from "zod";
import { getModel } from "@openacme/llm-provider";
import type { Agent } from "./agent.js";
import type { TokenUsage } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FORKED_STEP_CAP = 10;

export type SubagentStatus =
  | "completed"
  | "timeout"
  | "aborted"
  | "failed";

interface CommonArgs {
  parent: Agent;
  /** Wall-clock cap. Default 120_000ms. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface ForkedSubagentArgs extends CommonArgs {
  mode: "forked";
  /** Session id for cache + ALS context. Fork's work is NOT persisted here. */
  parentSessionId: string;
  /** User-shape text seed appended to the fork's history. */
  initialMessage: string;
  /** Prepended before the seed so prompts referring to "messages above"
   *  resolve. Identical bytes across turns share the prompt cache. */
  contextMessages?: readonly UIMessage[];
  stopWhen?: StopCondition<ToolSet>;
  /** Subset of parent's tools. Omit to inherit all. */
  toolFilter?: ReadonlySet<string>;
  /** Telemetry tag override. Default uses parent's tag. */
  telemetryFunctionId?: string;
}

export interface StructuredSubagentArgs<S extends ZodTypeAny>
  extends CommonArgs {
  mode: "structured";
  /** Side-query system prompt (does NOT see the parent's system). */
  system: string;
  user: string;
  /** Output schema — validation failure → `status: "failed"`. */
  schema: S;
  maxOutputTokens?: number;
}

export type SubagentArgs<S extends ZodTypeAny = ZodTypeAny> =
  | ForkedSubagentArgs
  | StructuredSubagentArgs<S>;

export interface ForkedSubagentResult {
  mode: "forked";
  status: SubagentStatus;
  /** Last assembled assistant UIMessage from the fork. May be null on
   *  early failure / immediate timeout. */
  message: UIMessage | null;
  usage?: TokenUsage;
  error?: string;
}

export interface StructuredSubagentResult<T> {
  mode: "structured";
  status: SubagentStatus;
  /** Parsed object validated against the schema. Null on any non-
   *  completed status. */
  object: T | null;
  usage?: TokenUsage;
  error?: string;
}

export type SubagentResult<T = unknown> =
  | ForkedSubagentResult
  | StructuredSubagentResult<T>;

// Overloads preserve the per-mode return type.
export function runSubagent(args: ForkedSubagentArgs): Promise<ForkedSubagentResult>;
export function runSubagent<S extends ZodTypeAny>(
  args: StructuredSubagentArgs<S>
): Promise<StructuredSubagentResult<z.infer<S>>>;
export async function runSubagent<S extends ZodTypeAny>(
  args: SubagentArgs<S>
): Promise<SubagentResult<z.infer<S>>> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
  const signals: AbortSignal[] = [timeoutCtrl.signal];
  if (args.abortSignal) signals.push(args.abortSignal);
  const combined =
    signals.length === 1 ? signals[0]! : combineAbortSignals(signals);

  try {
    if (args.mode === "forked") {
      return await runForked(args, combined, timeoutCtrl.signal);
    }
    return await runStructured(args, combined, timeoutCtrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function runForked(
  args: ForkedSubagentArgs,
  combined: AbortSignal,
  timeoutSignal: AbortSignal
): Promise<ForkedSubagentResult> {
  const seedMsg: UIMessage = {
    id: `fork_${randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text: args.initialMessage }],
  };

  const history: UIMessage[] = args.contextMessages
    ? [...args.contextMessages, seedMsg]
    : [seedMsg];

  let assembled: UIMessage | null = null;
  let usage: TokenUsage | undefined;

  try {
    const result = await args.parent.runStream({
      sessionId: args.parentSessionId,
      history,
      signal: combined,
      stopWhen: args.stopWhen ?? stepCountIs(DEFAULT_FORKED_STEP_CAP),
      toolFilter: args.toolFilter,
      telemetryFunctionId: args.telemetryFunctionId,
    });

    const stream = result.toUIMessageStream({ sendStart: false });
    for await (const m of readUIMessageStream<UIMessage>({ stream })) {
      assembled = m;
      if (combined.aborted) break;
    }

    if (combined.aborted) {
      return {
        mode: "forked",
        status: timeoutSignal.aborted ? "timeout" : "aborted",
        message: assembled,
      };
    }

    try {
      const u = await result.usage;
      usage = {
        inputTokens: u?.inputTokens,
        outputTokens: u?.outputTokens,
        totalTokens: u?.totalTokens,
      };
    } catch {
      // usage is optional; downstream loggers tolerate undefined.
    }
    return {
      mode: "forked",
      status: "completed",
      message: assembled,
      usage,
    };
  } catch (e) {
    if (combined.aborted) {
      return {
        mode: "forked",
        status: timeoutSignal.aborted ? "timeout" : "aborted",
        message: assembled,
      };
    }
    return {
      mode: "forked",
      status: "failed",
      message: assembled,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// Polyfill: `AbortSignal.any` landed in Node 19.13.
function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const native = (AbortSignal as unknown as {
    any?: (s: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof native === "function") return native(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

async function runStructured<S extends ZodTypeAny>(
  args: StructuredSubagentArgs<S>,
  combined: AbortSignal,
  timeoutSignal: AbortSignal
): Promise<StructuredSubagentResult<z.infer<S>>> {
  try {
    const result = await generateObject({
      model: getModel(args.parent.config.model),
      system: args.system,
      schema: args.schema,
      messages: [{ role: "user", content: args.user }],
      maxOutputTokens: args.maxOutputTokens,
      abortSignal: combined,
      experimental_telemetry: {
        isEnabled: true,
        functionId: `${args.parent.config.id}:subagent.structured`,
      },
    });
    return {
      mode: "structured",
      status: "completed",
      object: result.object as z.infer<S>,
      usage: result.usage
        ? {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined,
    };
  } catch (e) {
    if (combined.aborted) {
      return {
        mode: "structured",
        status: timeoutSignal.aborted ? "timeout" : "aborted",
        object: null,
      };
    }
    return {
      mode: "structured",
      status: "failed",
      object: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
