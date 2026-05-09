import type { UIMessage } from "ai";

/**
 * Token usage on a completed turn. Mirrors the AI SDK's usage shape (all
 * fields optional). Surfaced by `Agent.runStream`'s caller for telemetry
 * and proactive compression decisions.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Typed UIMessage variant for OpenAcme. Type-narrows the SDK's generic
 * `UIMessage<METADATA, DATA_PARTS, TOOLS>` so server `writer.write({...})`
 * and web `useChat({ onData })` both see compile-time-checked custom
 * data parts. Today we only use `data-session` (session-id pinning) and
 * `data-status` (mid-stream reconciliation hooks). Add new entries to
 * `OpenAcmeDataParts` to extend; the SDK keys data-part types as
 * `data-${keyof OpenAcmeDataParts}`.
 */
/**
 * Maps `data-${key}` part types to their `data` payload shape. The SDK
 * expects an index signature so it can key `data-${string}` parts; named
 * keys narrow the union for type-checked `writer.write({...})` calls.
 */
export interface OpenAcmeDataParts {
  /** Resolved session id; emitted before any tokens stream so the client
   *  can pin it. Always `transient: true` — never lands in the persisted
   *  message. */
  session: { sessionId: string };
  /** Mid-stream status reconciliation. Reuse the same `id` on the writer
   *  to update an existing chip in place (e.g. "compressing context" →
   *  "done"). Transient-by-default; persist when the status itself is
   *  meant to be part of the conversation history. */
  status: {
    /** Stable identifier — same id replaces the previous part. */
    id: string;
    kind: "info" | "warn" | "error" | "compressing" | "compressed";
    message: string;
  };
  // SDK-required index signature for unknown data-* keys.
  // `any` (not `unknown`) so named keys still narrow on a discriminated union.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Re-typed UIMessage. Use this in route signatures and `useChat` calls so
 * `writer.write({type: "data-session", ...})` and the matching `onData`
 * callback are type-checked end-to-end against `OpenAcmeDataParts`.
 */
export type OpenAcmeUIMessage = UIMessage<
  Record<string, unknown>,
  OpenAcmeDataParts
>;

export interface AgentConfig {
  id: string;
  name: string;
  model: import("@openacme/config").ModelConfig;
  persona: string;
  tools: string[];
  maxSteps: number;
  skillsIndex?: string;
  compression?: CompressionConfig;
}

export interface CompressionConfig {
  /** Absolute token threshold; takes precedence when set. null disables proactive. */
  thresholdTokens: number | null;
  /** Fraction of `contextWindow` to use as threshold. Requires `contextWindow`. */
  thresholdPercent: number | null;
  /** Model's context window in tokens. Required when using `thresholdPercent`.
   *  We don't try to auto-detect — Vercel AI SDK doesn't expose this on
   *  `LanguageModelV1`, and hardcoding a model→window table goes stale. */
  contextWindow: number | null;
  /** First N messages always kept (system + first exchange). */
  protectFirstN: number;
  /** Token-budget tail: walk backward, accumulating tokens until budget filled. */
  tailTokenBudget: number;
  /** Summary token target as ratio of compressed-content tokens. */
  summaryTargetRatio: number;
  /** Pre-summary input cap so we never feed an enormous history to the summarizer. */
  summarizerInputCharBudget: number;
  /** Optional auxiliary summarizer; falls back to the main `model` on failure. */
  summarizerModel?: import("@openacme/config").ModelConfig;
}
