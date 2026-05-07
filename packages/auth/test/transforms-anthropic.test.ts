import { describe, it, expect } from "vitest";
import {
  transformAnthropicOAuthBody,
  transformAnthropicOAuthResponse,
  stripToolPrefix,
} from "../src/transforms-anthropic.js";

const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const BILLING_PREFIX = "x-anthropic-billing-header";
const parse = (b: unknown) => JSON.parse(b as string);

const baseBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: "claude-opus-4-7",
    messages: [{ role: "user", content: "hello world" }],
    ...overrides,
  });

describe("transformAnthropicOAuthBody", () => {
  it("returns non-string bodies unchanged", () => {
    expect(transformAnthropicOAuthBody(undefined)).toBeUndefined();
    const obj = { foo: "bar" };
    expect(transformAnthropicOAuthBody(obj)).toBe(obj);
  });

  it("returns invalid JSON unchanged", () => {
    const garbage = "not json {{";
    expect(transformAnthropicOAuthBody(garbage)).toBe(garbage);
  });

  it("injects the billing header as system[0]", () => {
    const out = parse(transformAnthropicOAuthBody(baseBody()));
    expect(Array.isArray(out.system)).toBe(true);
    expect(out.system[0].type).toBe("text");
    expect(out.system[0].text.startsWith(`${BILLING_PREFIX}:`)).toBe(true);
  });

  it("inserts SYSTEM_IDENTITY when absent", () => {
    const out = parse(transformAnthropicOAuthBody(baseBody()));
    const identityIdx = out.system.findIndex(
      (s: { text?: string }) => s.text === SYSTEM_IDENTITY,
    );
    expect(identityIdx).toBeGreaterThanOrEqual(0);
  });

  it("normalizes a string `system` field to array form", () => {
    const out = parse(
      transformAnthropicOAuthBody(baseBody({ system: "you are a pirate" })),
    );
    expect(Array.isArray(out.system)).toBe(true);
  });

  it("relocates third-party system text into the first user message", () => {
    const out = parse(
      transformAnthropicOAuthBody(baseBody({ system: "you are a pirate" })),
    );
    // Only the billing header + identity remain; the pirate prompt is moved.
    expect(out.system).toHaveLength(2);
    expect(
      out.system.some((s: { text?: string }) => s.text === "you are a pirate"),
    ).toBe(false);

    const c = out.messages[0].content;
    const userText: string = typeof c === "string" ? c : c[0].text;
    expect(userText.startsWith("you are a pirate")).toBe(true);
  });

  it("splits a system entry that prepends SYSTEM_IDENTITY to extra text", () => {
    const out = parse(
      transformAnthropicOAuthBody(
        baseBody({
          system: [
            { type: "text", text: `${SYSTEM_IDENTITY}\n\nextra trailing text` },
          ],
        }),
      ),
    );
    // billing[0] + identity[1]; the trailing extra text gets relocated to user.
    expect(out.system).toHaveLength(2);
    expect(out.system[1].text).toBe(SYSTEM_IDENTITY);

    const c = out.messages[0].content;
    const userText: string = typeof c === "string" ? c : c[0].text;
    expect(userText).toContain("extra trailing text");
  });

  it("dedupes a stale pre-existing billing header", () => {
    const stale = `${BILLING_PREFIX}: cc_version=stale; cch=zzzzz;`;
    const out = parse(
      transformAnthropicOAuthBody(
        baseBody({
          system: [
            { type: "text", text: stale },
            { type: "text", text: SYSTEM_IDENTITY },
          ],
        }),
      ),
    );
    const billing = out.system.filter((s: { text?: string }) =>
      s.text?.startsWith(BILLING_PREFIX),
    );
    expect(billing).toHaveLength(1);
    expect(billing[0].text).not.toContain("stale");
  });

  it("produces a stable billing header for identical first-user-message text", () => {
    const a = parse(transformAnthropicOAuthBody(baseBody()));
    const b = parse(transformAnthropicOAuthBody(baseBody()));
    expect(a.system[0].text).toBe(b.system[0].text);
  });

  it("varies the billing header when first-user-message text changes", () => {
    const a = parse(transformAnthropicOAuthBody(baseBody()));
    const b = parse(
      transformAnthropicOAuthBody(
        JSON.stringify({
          model: "claude-opus-4-7",
          messages: [
            { role: "user", content: "different prompt with enough chars" },
          ],
        }),
      ),
    );
    expect(a.system[0].text).not.toBe(b.system[0].text);
  });

  it("prefixes tool names with mcp_<PascalCase>", () => {
    const out = parse(
      transformAnthropicOAuthBody(
        baseBody({ tools: [{ name: "bash" }, { name: "edit_file" }] }),
      ),
    );
    expect(out.tools[0].name).toBe("mcp_Bash");
    expect(out.tools[1].name).toBe("mcp_Edit_file");
  });

  it("prefixes tool_use names within messages", () => {
    const out = parse(
      transformAnthropicOAuthBody(
        JSON.stringify({
          model: "claude-opus-4-7",
          messages: [
            { role: "user", content: "do it" },
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "x", name: "bash", input: {} },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "x", content: "ok" },
              ],
            },
          ],
        }),
      ),
    );
    const blocks = out.messages[1].content as Array<{ type: string; name?: string }>;
    const toolUse = blocks.find((b) => b.type === "tool_use");
    expect(toolUse?.name).toBe("mcp_Bash");
  });

  it("drops orphaned tool_use blocks but preserves sibling text", () => {
    const out = parse(
      transformAnthropicOAuthBody(
        JSON.stringify({
          model: "claude-opus-4-7",
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: [
                { type: "text", text: "calling tool" },
                { type: "tool_use", id: "orphan", name: "bash", input: {} },
              ],
            },
          ],
        }),
      ),
    );
    const last = out.messages[out.messages.length - 1].content as Array<{
      type: string;
    }>;
    expect(last.find((b) => b.type === "tool_use")).toBeUndefined();
    expect(last.find((b) => b.type === "text")).toBeDefined();
  });

  it("drops messages whose only content was an orphaned tool_result", () => {
    const out = parse(
      transformAnthropicOAuthBody(
        JSON.stringify({
          model: "claude-opus-4-7",
          messages: [
            { role: "user", content: "go" },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "ghost", content: "stuff" },
              ],
            },
          ],
        }),
      ),
    );
    expect(out.messages).toHaveLength(1);
  });

  it("keeps matched tool_use/tool_result pairs intact", () => {
    const out = parse(
      transformAnthropicOAuthBody(
        JSON.stringify({
          model: "claude-opus-4-7",
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "x", name: "bash", input: {} },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "x", content: "ok" },
              ],
            },
          ],
        }),
      ),
    );
    expect(out.messages).toHaveLength(3);
    expect(out.messages[1].content[0].type).toBe("tool_use");
    expect(out.messages[2].content[0].type).toBe("tool_result");
  });
});

describe("stripToolPrefix", () => {
  it("rewrites a single tool_use name", () => {
    const input = `{"type":"tool_use","id":"x","name":"mcp_Shell","input":{}}`;
    expect(stripToolPrefix(input)).toBe(
      `{"type":"tool_use","id":"x","name": "shell","input":{}}`,
    );
  });

  it("only lowercases the first character (preserves underscored names)", () => {
    // Round-trip: prefixName("read_file") = "mcp_Read_file" → stripToolPrefix → "read_file"
    const input = `{"name":"mcp_Read_file"}`;
    expect(stripToolPrefix(input)).toBe(`{"name": "read_file"}`);
  });

  it("rewrites every occurrence in a multi-tool-use chunk", () => {
    const input = `{"name":"mcp_Bash"} ... {"name":"mcp_Read"}`;
    const out = stripToolPrefix(input);
    expect(out).toContain(`"name": "bash"`);
    expect(out).toContain(`"name": "read"`);
    expect(out).not.toContain("mcp_");
  });

  it("tolerates whitespace around the colon", () => {
    expect(stripToolPrefix(`"name"   :    "mcp_Edit"`)).toBe(`"name": "edit"`);
  });

  it("is a no-op when no mcp_ prefix is present", () => {
    const text = `event: message_start\ndata: {"foo":"bar"}\n\n`;
    expect(stripToolPrefix(text)).toBe(text);
  });

  it("does not rewrite non-name fields that happen to start with mcp_", () => {
    // The regex anchors on "name": specifically.
    const text = `{"id":"mcp_xyz","other":"mcp_abc"}`;
    expect(stripToolPrefix(text)).toBe(text);
  });
});

describe("transformAnthropicOAuthResponse", () => {
  it("returns the input unchanged when body is null", () => {
    const r = new Response(null, { status: 200 });
    expect(transformAnthropicOAuthResponse(r)).toBe(r);
  });

  it("rewrites tool names in a streaming SSE body", async () => {
    const sse =
      `event: content_block_start\n` +
      `data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"x","name":"mcp_Shell"}}\n\n` +
      `event: content_block_stop\n` +
      `data: {"type":"content_block_stop"}\n\n`;
    const upstream = new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const wrapped = transformAnthropicOAuthResponse(upstream);
    const text = await wrapped.text();
    expect(text).toContain(`"name": "shell"`);
    expect(text).not.toContain("mcp_Shell");
  });

  it("rewrites tool names in a non-OK error body", async () => {
    const upstream = new Response(`{"error":{"name":"mcp_Bash"}}`, {
      status: 400,
    });
    const wrapped = transformAnthropicOAuthResponse(upstream);
    expect(wrapped.status).toBe(400);
    const text = await wrapped.text();
    expect(text).toContain(`"name": "bash"`);
  });

  it("preserves status, statusText, and headers", async () => {
    const upstream = new Response(`data: {}\n\n`, {
      status: 200,
      statusText: "OK",
      headers: { "x-custom": "1", "content-type": "text/event-stream" },
    });
    const wrapped = transformAnthropicOAuthResponse(upstream);
    expect(wrapped.status).toBe(200);
    expect(wrapped.statusText).toBe("OK");
    expect(wrapped.headers.get("x-custom")).toBe("1");
  });

  it("does not split mcp_<X> across SSE event boundaries", async () => {
    // Two events; the second contains a tool_use whose name spans no boundary.
    const part1 = `event: a\ndata: {}\n\n`;
    const part2 = `event: b\ndata: {"name":"mcp_List_files"}\n\n`;
    const upstream = new Response(part1 + part2, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const wrapped = transformAnthropicOAuthResponse(upstream);
    const text = await wrapped.text();
    expect(text).toContain(`"name": "list_files"`);
    expect(text).not.toContain("mcp_");
  });
});
