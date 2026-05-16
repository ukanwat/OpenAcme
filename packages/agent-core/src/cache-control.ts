import type { ModelMessage } from "ai";
import type { ModelConfig } from "@openacme/config";

export type CacheTtl = "5m" | "1h";

type EphemeralMarker = { type: "ephemeral"; ttl?: "1h" };

function ephemeral(ttl: CacheTtl): EphemeralMarker {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/**
 * `system_and_3` strategy — 1 breakpoint on system + up to 3 on the most
 * recent non-system messages. 4 is the Anthropic max; the rolling tail
 * keeps the prefix-cache walk inside the 20-block lookback window over
 * long agentic turns.
 */
export function applyAnthropicCacheControl(
  messages: ModelMessage[],
  ttl: CacheTtl = "5m",
): ModelMessage[] {
  if (messages.length === 0) return messages;

  const marker = ephemeral(ttl);
  const out = messages.map(cloneMessage);

  let used = 0;
  if (out[0]!.role === "system") {
    markCacheable(out[0]!, marker);
    used += 1;
  }

  const remaining = 4 - used;
  const nonSystem: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.role !== "system") nonSystem.push(i);
  }
  for (const i of nonSystem.slice(-remaining)) {
    markCacheable(out[i]!, marker);
  }

  return out;
}

/** Decide which Anthropic-cache layout (if any) applies to this model config. */
export function anthropicCachePolicy(
  cfg: ModelConfig,
): "native" | "openrouter" | "none" {
  if (cfg.provider === "anthropic") return "native";
  if (cfg.provider === "openrouter" && cfg.model) {
    const m = cfg.model.toLowerCase();
    if (m.startsWith("anthropic/") || m.includes("claude")) return "openrouter";
  }
  return "none";
}

function cloneMessage(m: ModelMessage): ModelMessage {
  const c = (m as { content: unknown }).content;
  if (typeof c === "string") return { ...m };
  if (Array.isArray(c)) {
    return { ...m, content: c.map((p) => ({ ...(p as object) })) } as ModelMessage;
  }
  return { ...m };
}

function markCacheable(m: ModelMessage, marker: EphemeralMarker): void {
  const opts = { anthropic: { cacheControl: marker } };
  const msg = m as { content: unknown; providerOptions?: Record<string, unknown> };

  // For string content (always for system, sometimes for user/assistant): put
  // providerOptions on the message envelope. The @ai-sdk/anthropic SDK reads
  // it from there for system blocks and as the last-part fallback for users.
  // Don't convert string→TextPart[] — SystemModelMessage validator rejects it.
  if (typeof msg.content === "string" || msg.content == null) {
    msg.providerOptions = { ...(msg.providerOptions ?? {}), ...opts };
    return;
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    const arr = msg.content as Array<{ providerOptions?: Record<string, unknown> }>;
    const last = arr[arr.length - 1]!;
    last.providerOptions = { ...(last.providerOptions ?? {}), ...opts };
  }
}
