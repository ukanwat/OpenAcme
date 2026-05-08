import { APICallError } from "ai";

/**
 * Decide whether an error from a model call should trigger compression+retry.
 *
 * Two reasons qualify, mirroring Hermes's reactive triggers:
 *   - `payload_too_large` — HTTP 413 (request body too big for the gateway)
 *   - `context_overflow`  — provider rejected because input tokens exceeded
 *                           the model's context window (usually 400/422,
 *                           sometimes 500 from local backends like vLLM)
 *
 * Vercel AI SDK throws `APICallError` for HTTP-layer failures and gives us
 * `statusCode` + `responseBody` cleanly — we use the static `isInstance`
 * guard instead of probing fields ourselves. For exotic backends or wrapper
 * gateways that swallow the status, we still do message-pattern matching
 * over `responseBody` and `error.message` as a fallback.
 *
 * Pattern source: `.hermes-ref/agent/error_classifier.py:147-201`. Hermes
 * hardened these against real production traffic across vLLM, Ollama,
 * llama.cpp, AWS Bedrock, Anthropic, and OpenAI — copying the patterns is
 * cheap insurance even though the SDK normalizes most cases for us.
 */

export type CompressionReason = "payload_too_large" | "context_overflow";

export interface ClassifiedError {
  shouldCompress: boolean;
  reason?: CompressionReason;
  statusCode?: number;
  message: string;
}

const PAYLOAD_TOO_LARGE_PATTERNS = [
  "request entity too large",
  "payload too large",
  "error code: 413",
];

// Provider phrases for "your input ran past the model's context window".
// We pattern-match against either the SDK-extracted `responseBody` or, if
// that's absent, the error `message`. The list is intentionally broad —
// missing a context-overflow signal means the session gets stuck in a
// retry loop, which is much worse than over-triggering compression.
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
  // AWS Bedrock Converse API
  "max input token",
  "input token",
  "exceeds the maximum number of input tokens",
];

/**
 * Pull as much text as we can out of an arbitrary thrown value so we can
 * pattern-match it. APICallError carries `responseBody` (raw provider JSON
 * or text); plain Errors only have `message`. Both are joined and lowercased.
 */
function extractText(err: unknown): string {
  if (typeof err === "string") return err.toLowerCase();
  if (!err || typeof err !== "object") return String(err).toLowerCase();
  const parts: string[] = [];
  if (APICallError.isInstance(err)) {
    if (err.responseBody) parts.push(err.responseBody);
    if (err.message) parts.push(err.message);
  } else {
    const e = err as { message?: string; toString?: () => string };
    if (e.message) parts.push(e.message);
    else parts.push(String(err));
  }
  return parts.join(" ").toLowerCase();
}

function extractStatus(err: unknown): number | undefined {
  if (APICallError.isInstance(err)) return err.statusCode;
  if (err && typeof err === "object") {
    const e = err as { status?: number; statusCode?: number };
    return e.status ?? e.statusCode;
  }
  return undefined;
}

export function classifyError(err: unknown): ClassifiedError {
  const statusCode = extractStatus(err);
  const text = extractText(err);
  const message = err instanceof Error ? err.message : String(err);

  // 413 status code is the strongest signal — straight to payload compression.
  if (statusCode === 413) {
    return { shouldCompress: true, reason: "payload_too_large", statusCode, message };
  }
  if (PAYLOAD_TOO_LARGE_PATTERNS.some((p) => text.includes(p))) {
    return { shouldCompress: true, reason: "payload_too_large", statusCode, message };
  }

  // Context overflow — varies by status code (400/422/500 depending on
  // backend), so we match on text only.
  if (CONTEXT_OVERFLOW_PATTERNS.some((p) => text.includes(p))) {
    return { shouldCompress: true, reason: "context_overflow", statusCode, message };
  }

  return { shouldCompress: false, statusCode, message };
}
