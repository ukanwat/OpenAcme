/**
 * Anthropic OAuth body transformations — required for Claude Code subscription
 * authentication. Without these the API returns 400 (out of extra usage / bad
 * system prompt / bad tool names).
 *
 * Vendored from:
 *   https://github.com/griffinmartin/opencode-claude-auth/blob/main/src/transforms.ts
 *   https://github.com/griffinmartin/opencode-claude-auth/blob/main/src/signing.ts
 * License: MIT (see https://github.com/griffinmartin/opencode-claude-auth/blob/main/LICENSE)
 *
 * Trimmed of opencode-specific bits (model overrides, third-party prompt move,
 * cache-control handling). Keeping the core contract:
 *  - Inject billing header as system[0]
 *  - Inject Claude Code identity prefix as a separate system block
 *  - Prefix tool names with mcp_<PascalCase>
 *  - Repair orphaned tool_use / tool_result pairs
 */

import { createHash } from "node:crypto";

const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const TOOL_PREFIX = "mcp_";
const BILLING_SALT = "59cf53e54c78";
const DEFAULT_CC_VERSION = "2.1.74";
const DEFAULT_ENTRYPOINT = "sdk-cli";

type SystemEntry = { type?: string; text?: string } & Record<string, unknown>;
type ContentBlock = { type?: string; text?: string; name?: string } & Record<string, unknown>;
type Message = {
  role?: string;
  content?: string | ContentBlock[];
};

interface AnthropicBody {
  model?: string;
  system?: SystemEntry[] | string;
  tools?: Array<{ name?: string } & Record<string, unknown>>;
  messages?: Message[];
  [k: string]: unknown;
}

function prefixName(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function extractFirstUserMessageText(messages: Message[]): string {
  const userMsg = messages.find((m) => m.role === "user");
  if (!userMsg) return "";
  const content = userMsg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === "text");
    if (textBlock?.text) return textBlock.text;
  }
  return "";
}

function computeCch(messageText: string): string {
  return createHash("sha256").update(messageText).digest("hex").slice(0, 5);
}

function computeVersionSuffix(messageText: string, version: string): string {
  const sampled = [4, 7, 20]
    .map((i) => (i < messageText.length ? messageText[i] : "0"))
    .join("");
  const input = `${BILLING_SALT}${sampled}${version}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

function buildBillingHeaderValue(
  messages: Message[],
  version: string,
  entrypoint: string,
): string {
  const text = extractFirstUserMessageText(messages);
  const suffix = computeVersionSuffix(text, version);
  const cch = computeCch(text);
  return (
    `x-anthropic-billing-header: ` +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    `cch=${cch};`
  );
}

function repairToolPairs(messages: Message[]): Message[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const id = block["id"];
      if (block.type === "tool_use" && typeof id === "string") toolUseIds.add(id);
      const tuid = block["tool_use_id"];
      if (block.type === "tool_result" && typeof tuid === "string") toolResultIds.add(tuid);
    }
  }

  const orphanedUses = new Set<string>();
  for (const id of toolUseIds) if (!toolResultIds.has(id)) orphanedUses.add(id);
  const orphanedResults = new Set<string>();
  for (const id of toolResultIds) if (!toolUseIds.has(id)) orphanedResults.add(id);

  if (orphanedUses.size === 0 && orphanedResults.size === 0) return messages;

  return messages
    .map((message) => {
      if (!Array.isArray(message.content)) return message;
      const filtered = message.content.filter((block) => {
        const id = block["id"];
        if (block.type === "tool_use" && typeof id === "string") return !orphanedUses.has(id);
        const tuid = block["tool_use_id"];
        if (block.type === "tool_result" && typeof tuid === "string") return !orphanedResults.has(tuid);
        return true;
      });
      return { ...message, content: filtered };
    })
    .filter((m) => !(Array.isArray(m.content) && m.content.length === 0));
}

/**
 * Apply all required Anthropic OAuth body transformations.
 * Returns the rewritten body as a JSON string, or the input unchanged if
 * parsing fails (so we never break non-JSON requests).
 */
export function transformAnthropicOAuthBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  let parsed: AnthropicBody;
  try {
    parsed = JSON.parse(body) as AnthropicBody;
  } catch {
    return body;
  }

  // 1. Normalize system to array form.
  let system: SystemEntry[];
  if (Array.isArray(parsed.system)) {
    system = parsed.system;
  } else if (typeof parsed.system === "string" && parsed.system) {
    system = [{ type: "text", text: parsed.system }];
  } else {
    system = [];
  }

  // 2. Inject billing header at system[0].
  const messages = parsed.messages ?? [];
  const version = process.env["ANTHROPIC_CLI_VERSION"] ?? DEFAULT_CC_VERSION;
  const entrypoint = process.env["CLAUDE_CODE_ENTRYPOINT"] ?? DEFAULT_ENTRYPOINT;
  const billingHeader = buildBillingHeaderValue(messages, version, entrypoint);
  system = system.filter(
    (e) =>
      !(e.type === "text" && typeof e.text === "string" && e.text.startsWith("x-anthropic-billing-header")),
  );
  system.unshift({ type: "text", text: billingHeader });

  // 3. Ensure SYSTEM_IDENTITY is a standalone system entry (not concatenated
  //    with subsequent text). Anthropic's OAuth validator rejects requests
  //    where the identity string is buried inside a longer block.
  const split: SystemEntry[] = [];
  for (const entry of system) {
    if (
      entry.type === "text" &&
      typeof entry.text === "string" &&
      entry.text.startsWith(SYSTEM_IDENTITY) &&
      entry.text.length > SYSTEM_IDENTITY.length
    ) {
      const rest = entry.text.slice(SYSTEM_IDENTITY.length).replace(/^\n+/, "");
      const { text: _t, ...rest_props } = entry;
      const { cache_control: _cc, ...identity_props } = rest_props as Record<string, unknown>;
      split.push({ ...identity_props, type: "text", text: SYSTEM_IDENTITY });
      if (rest.length > 0) split.push({ ...rest_props, type: "text", text: rest });
    } else {
      split.push(entry);
    }
  }
  system = split;

  // 4. If SYSTEM_IDENTITY isn't already present after the billing header,
  //    insert it. (Required for the validator.)
  const hasIdentity = system.some(
    (e) => e.type === "text" && typeof e.text === "string" && e.text.startsWith(SYSTEM_IDENTITY),
  );
  if (!hasIdentity) {
    system.splice(1, 0, { type: "text", text: SYSTEM_IDENTITY });
  }

  // 5. Move non-core system entries (anything that's not billing or identity)
  //    into the first user message. Anthropic 400s on third-party system text.
  const BILLING_PREFIX = "x-anthropic-billing-header";
  const kept: SystemEntry[] = [];
  const moved: string[] = [];
  for (const entry of system) {
    const txt = entry.text ?? "";
    if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(SYSTEM_IDENTITY)) {
      kept.push(entry);
    } else if (txt.length > 0) {
      moved.push(txt);
    }
  }
  if (moved.length > 0 && Array.isArray(parsed.messages)) {
    const firstUser = parsed.messages.find((m) => m.role === "user");
    if (firstUser) {
      system = kept;
      const prefix = moved.join("\n\n");
      if (typeof firstUser.content === "string") {
        firstUser.content = prefix + "\n\n" + firstUser.content;
      } else if (Array.isArray(firstUser.content)) {
        firstUser.content.unshift({ type: "text", text: prefix });
      }
    }
  }
  parsed.system = system;

  // 6. Prefix tool names with mcp_<PascalCase>. Anthropic's validator flags
  //    lowercase tool names as non-Claude-Code clients.
  if (Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map((tool) => ({
      ...tool,
      name: tool.name ? prefixName(tool.name) : tool.name,
    }));
  }
  if (Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.map((block) => {
          if (block.type !== "tool_use" || typeof block.name !== "string") return block;
          return { ...block, name: prefixName(block.name) };
        }),
      };
    });
  }

  // 7. Repair orphaned tool pairs.
  if (Array.isArray(parsed.messages)) {
    parsed.messages = repairToolPairs(parsed.messages);
  }

  return JSON.stringify(parsed);
}
