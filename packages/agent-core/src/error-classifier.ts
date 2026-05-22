import { APICallError } from "ai";

/**
 * Decide whether an error from a model call should trigger reactive
 * compression + retry. Three branches:
 *
 *   - 413 / `request entity too large` → payload_too_large
 *   - 400 + context-overflow phrasing → context_overflow
 *   - 429 + "extra usage" + "long context" → Anthropic long-context tier
 *     gate, recovered the same way as a plain context overflow
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

export function extractStatusCode(err: unknown): number | undefined {
  if (APICallError.isInstance(err)) return err.statusCode;
  if (err && typeof err === "object") {
    const e = err as { status?: number; statusCode?: number; cause?: unknown };
    if (typeof e.statusCode === "number") return e.statusCode;
    if (typeof e.status === "number" && e.status >= 100 && e.status < 600) {
      return e.status;
    }
    // One-hop cause walk for wrapped APICallErrors.
    if (e.cause && e.cause !== err) return extractStatusCode(e.cause);
  }
  return undefined;
}

/** Original-case error text for surfacing to humans. Concatenates
 *  `message` + `responseBody` so OpenRouter's `metadata.raw` wrapping
 *  of upstream provider errors is included verbatim. Walks one-hop
 *  `.cause` chain to find a wrapped APICallError — `streamText` often
 *  hands `onError` a generic Error whose `cause` is the real
 *  APICallError with the response body attached. */
export function extractErrorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (APICallError.isInstance(err)) {
    const parts = [err.message ?? "", err.responseBody ?? ""].filter(Boolean);
    return parts.join("\n").trim();
  }
  if (err && typeof err === "object") {
    const e = err as { message?: string; cause?: unknown };
    if (e.cause && e.cause !== err) {
      const inner = extractErrorText(e.cause);
      if (inner) return inner;
    }
    return e.message ?? String(err);
  }
  return String(err);
}

function extractText(err: unknown): string {
  return extractErrorText(err).toLowerCase();
}

export function classifyError(err: unknown): ClassifiedError {
  const statusCode = extractStatusCode(err);
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
