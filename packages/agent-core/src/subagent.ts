/**
 * Subagent primitive — one entry point for all "subordinate model
 * invocations" an agent makes during a turn (recall side queries,
 * post-turn extraction, future side-quests / consolidation / etc).
 *
 * Two modes today; extensible by adding a new branch to the
 * discriminated spec without touching call sites that don't care.
 *
 *   mode: "forked"
 *     Multi-turn agent loop that inherits the parent's cached system
 *     prompt + tools (with optional `toolFilter` to drop tools the
 *     fork shouldn't have). Routes through `parent.runStream` so
 *     provider-side prompt-cache sharing kicks in. Used by the
 *     extractor — needs the memory tool, may take 2-4 turns.
 *
 *   mode: "structured"
 *     One-shot side query with a custom system prompt and a JSON
 *     schema for the output. Routes through `generateObject` against
 *     the parent's model. Used by the recall selector — focused
 *     judgment over a manifest, no tools, no agent identity needed.
 *
 * Both modes share:
 *   - Bounded execution: `timeoutMs` (default 120s) + caller
 *     `abortSignal`, combined via `AbortSignal.any`.
 *   - Failure tolerance: never throws. Returns a discriminated
 *     `SubagentStatus` so callers handle outcomes uniformly.
 *   - Telemetry: structured mode is tagged
 *     `${agent.id}:subagent.structured`; forked mode passes
 *     `telemetryFunctionId` (default uses the parent's tag, callers
 *     override per subagent kind — e.g. extractor uses
 *     `:subagent.forked.extractor`). Telemetry is OFF unless
 *     `OPENACME_TELEMETRY=1` (dev-only Logfire export); when on,
 *     these tags split subagent usage from main-turn usage in the
 *     dashboard.
 *
 * Cross-provider notes:
 *   - "forked" mode works wherever the agent's main model works
 *     (every provider OpenAcme supports today).
 *   - "structured" mode uses `generateObject`, which uses
 *     provider-native structured output where available (Anthropic
 *     tool-calling, OpenAI structured outputs, Google JSON schema,
 *     OpenRouter pass-through). For models that don't support it
 *     (small Ollama models, some custom endpoints), `generateObject`
 *     throws → caller sees `status: "failed"` and degrades. The
 *     selector treats that as "no recall this turn"; agent still
 *     functions normally.
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
  /** External abort. Combined with the timeout via `AbortSignal.any`. */
  abortSignal?: AbortSignal;
}

export interface ForkedSubagentArgs extends CommonArgs {
  mode: "forked";
  /** Session id to share the parent's cached system prompt + ALS
   *  context. The fork's work is NOT persisted under this session;
   *  the session id is purely for cache + tool-handler lookups. */
  parentSessionId: string;
  /** Single user-shape text seed appended to the fork's history. */
  initialMessage: string;
  /** Optional UIMessages to include BEFORE the seed message. The fork's
   *  effective history becomes `[...contextMessages, seedMsg]` so the
   *  model can analyze the parent's conversation when the seed prompt
   *  refers to "the messages above" (e.g. the extractor's "analyze the
   *  most recent N messages"). Identical context across turns shares
   *  the provider-side prompt cache; only the seed is new each call.
   *
   *  Omit for fresh-context forks (e.g. a side-quest that doesn't
   *  need to see what the user just said). */
  contextMessages?: readonly UIMessage[];
  /** Override the agentic step cap. Default `stepCountIs(10)`. */
  stopWhen?: StopCondition<ToolSet>;
  /** Restrict the fork's tools to this subset of `parent.config.tools`.
   *  Omit to inherit all of the parent's tools. */
  toolFilter?: ReadonlySet<string>;
  /** Override telemetry functionId for cost attribution in dev
   *  (Logfire). Default uses the parent's tag. Forks set this so
   *  extractor / future side-quest usage can be split out from main
   *  turns. No-op when telemetry is off (production default). */
  telemetryFunctionId?: string;
}

export interface StructuredSubagentArgs<S extends ZodTypeAny>
  extends CommonArgs {
  mode: "structured";
  /** Custom system prompt — focused on the side-query task. Does NOT
   *  see the parent's system prompt. */
  system: string;
  /** Single user message body. */
  user: string;
  /** Output schema. The model's response is validated against this; on
   *  validation failure the call counts as `failed`. */
  schema: S;
  /** Output token cap. Cheap structured calls usually need <512. */
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

// Function overloads — preserves typed return based on the mode and
// the schema's inferred type for structured calls.
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

  // History the model sees: parent's conversation (when supplied) +
  // the fork's seed at the end. Identical context across turns shares
  // provider-side prompt caching; only the seed differs each call.
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

    // SDK's canonical UIMessage assembler — handles step boundaries +
    // tool-call/result pairing the same way the host route does.
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

/**
 * Compose multiple AbortSignals into one that fires when any input
 * fires. Polyfill for Node 18 (where `AbortSignal.any` doesn't exist —
 * it landed in Node 19.13). On Node ≥20 we delegate to the native
 * implementation; older runtimes get the manual listener path.
 */
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
