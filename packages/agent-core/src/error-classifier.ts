import { APICallError } from "ai";

/**
 * Decide whether an error from a model call should trigger reactive
 * compression + retry. Mirrors the three compression-triggering branches of
 * Hermes's `classify_api_error` (`.hermes-ref/agent/error_classifier.py`):
 *
 *   - 413 / `request entity too large` → payload_too_large
 *   - 400 + context-overflow phrasing → context_overflow
 *   - 429 + "extra usage" + "long context" → Anthropic long-context tier
 *     gate, recovered the same way as a plain context overflow
 *
 * Other reasons in Hermes's taxonomy (auth, billing, rate_limit, model_not_
 * found, provider_policy_blocked, image_too_large, ...) drive credential
 * rotation or provider fallback in Hermes — neither of which exists here on
 * top of the Vercel AI SDK. Adding them as informational classifications
 * would just be dead weight, so we don't.
 */

export type CompressionReason = "payload_too_large" | "context_overflow";

export interface ClassifiedError {
  /** Non-null iff this error should trigger reactive compression + retry. */
  compressionReason: CompressionReason | null;
}

const PAYLOAD_TOO_LARGE_PATTERNS = [
  "request entity too large",
  "payload too large",
  "error code: 413",
];

// English + code-style + CJK + Bedrock variants. We pattern-match on a
// lowercased concatenation of `error.message` and `responseBody`, so
// underscore-separated error codes (e.g. `context_length_exceeded`) need
// their own entries — `"context length exceeded"` (spaced) won't match
// them. Over-triggering compression is much less harmful than missing a
// signal and getting stuck in a retry loop.
const CONTEXT_OVERFLOW_PATTERNS = [
  "context length",
  "context size",
  "maximum context",
  "token limit",
  "too many tokens",
  "reduce the length",
  "exceeds the limit",
  "context window",
  "prompt is too long",
  "prompt exceeds max length",
  "max_tokens",
  "maximum number of tokens",
  // Code-style variants (OpenAI / OpenRouter `error.code` strings)
  "context_length_exceeded",
  "max_tokens_exceeded",
  // vLLM / local inference
  "exceeds the max_model_len",
  "max_model_len",
  "prompt length",
  "input is too long",
  "maximum model length",
  // Ollama
  "context length exceeded",
  "truncating input",
  // llama.cpp / llama-server
  "slot context",
  "n_ctx_slot",
  // CJK error messages from some Asian providers (DashScope, Qwen, etc.)
  "超过最大长度",
  "上下文长度",
  // AWS Bedrock Converse
  "max input token",
  "input token",
  "exceeds the maximum number of input tokens",
];

function extractStatus(err: unknown): number | undefined {
  if (APICallError.isInstance(err)) return err.statusCode;
  if (err && typeof err === "object") {
    const e = err as { status?: number; statusCode?: number; cause?: unknown };
    if (typeof e.statusCode === "number") return e.statusCode;
    if (typeof e.status === "number" && e.status >= 100 && e.status < 600) {
      return e.status;
    }
    // One-hop cause walk for wrapped APICallErrors.
    if (e.cause && e.cause !== err) return extractStatus(e.cause);
  }
  return undefined;
}

function extractText(err: unknown): string {
  if (typeof err === "string") return err.toLowerCase();
  if (APICallError.isInstance(err)) {
    // Substring matching `responseBody` directly catches OpenRouter's
    // `error.metadata.raw` wrapping of upstream provider messages without
    // having to parse the JSON.
    return `${err.message ?? ""} ${err.responseBody ?? ""}`.toLowerCase();
  }
  if (err && typeof err === "object") {
    const m = (err as { message?: string }).message;
    return (m ?? String(err)).toLowerCase();
  }
  return String(err).toLowerCase();
}

export function classifyError(err: unknown): ClassifiedError {
  const statusCode = extractStatus(err);
  const text = extractText(err);

  if (statusCode === 413) return { compressionReason: "payload_too_large" };

  // Anthropic long-context tier gate. Match BEFORE generic 429 → no-op
  // (we don't classify rate limits at all).
  if (
    statusCode === 429 &&
    text.includes("extra usage") &&
    text.includes("long context")
  ) {
    return { compressionReason: "context_overflow" };
  }

  if (PAYLOAD_TOO_LARGE_PATTERNS.some((p) => text.includes(p))) {
    return { compressionReason: "payload_too_large" };
  }
  if (CONTEXT_OVERFLOW_PATTERNS.some((p) => text.includes(p))) {
    return { compressionReason: "context_overflow" };
  }

  return { compressionReason: null };
}
