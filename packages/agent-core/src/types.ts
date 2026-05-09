/**
 * Stream chunk types emitted by the agent during a conversation.
 */
export type StreamChunk =
  | { type: "session"; sessionId: string }
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolName: string; args: Record<string, unknown>; toolCallId: string }
  | { type: "tool-result"; toolName: string; result: string; toolCallId: string }
  | { type: "error"; error: string }
  | { type: "stopped" }
  | { type: "done"; usage?: TokenUsage };

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

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
