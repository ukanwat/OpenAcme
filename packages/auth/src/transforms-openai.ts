/**
 * OpenAI ChatGPT (Codex) backend body transformations.
 *
 * The chatgpt.com/backend-api/codex/responses endpoint speaks the Responses
 * API but with a stricter contract than api.openai.com:
 *  - `instructions` MUST be a top-level string (not a `developer` role inside
 *    the input array)
 *  - `store` MUST be `false`
 *  - sampling params (`temperature`, `top_p`) are rejected
 *  - `max_output_tokens` is rejected ("Unsupported parameter") —
 *    ChatGPT-subscription tier caps output server-side, so the parameter
 *    isn't accepted
 *  - model name must be in the Codex namespace (gpt-5.1-codex, etc.)
 *
 * Vendored & adapted from:
 *   https://github.com/numman-ali/opencode-openai-codex-auth (MIT)
 *
 * We DO NOT inject the Codex CLI's giant system prompt template — that adds
 * a heavy dependency on github.com/openai/codex release polling. The basic
 * contract above seems sufficient for non-agentic chat; tool flows may need
 * the full prompt later.
 */

/**
 * Strip provider prefixes (`openai/...`) and trim. Pass everything else
 * through unchanged — the ChatGPT backend's accepted model set varies per
 * account and we don't want to silently rewrite a working name into one the
 * user's plan rejects. Verified by live probing on a ChatGPT Plus account:
 * `gpt-5.2` and `gpt-5.5` work; remapping them away breaks them.
 */
export function normalizeCodexModel(model: string | undefined): string {
  if (!model || !model.trim()) return "gpt-5.2";
  const id = model.includes("/") ? model.split("/").pop()! : model;
  return id.trim();
}

interface CodexBody {
  model?: string;
  input?: Array<{
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  }>;
  instructions?: string;
  store?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  [k: string]: unknown;
}

/** Apply all required ChatGPT-backend body transformations. */
export function transformCodexOAuthBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  let parsed: CodexBody;
  try {
    parsed = JSON.parse(body) as CodexBody;
  } catch {
    return body;
  }

  // Required: store: false, no sampling params, no output cap.
  parsed.store = false;
  delete parsed.temperature;
  delete parsed.top_p;
  delete parsed.max_output_tokens;

  // Normalize model name.
  parsed.model = normalizeCodexModel(parsed.model);

  // Move developer/system role from input[] to top-level instructions.
  if (Array.isArray(parsed.input)) {
    const sysIdx = parsed.input.findIndex(
      (m) => m.role === "developer" || m.role === "system",
    );
    if (sysIdx >= 0) {
      const sys = parsed.input[sysIdx]!;
      const text = typeof sys.content === "string"
        ? sys.content
        : Array.isArray(sys.content)
          ? sys.content.map((c) => c.text ?? "").join("")
          : "";
      // Concat with any pre-existing instructions (rare).
      parsed.instructions = parsed.instructions ? `${parsed.instructions}\n\n${text}` : text;
      parsed.input.splice(sysIdx, 1);
    }
  }

  // Backend rejects empty/missing instructions ("Instructions are required").
  if (!parsed.instructions || !String(parsed.instructions).trim()) {
    parsed.instructions = "You are a helpful assistant.";
  }

  return JSON.stringify(parsed);
}
