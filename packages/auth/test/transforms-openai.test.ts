import { describe, it, expect } from "vitest";
import {
  transformCodexOAuthBody,
  normalizeCodexModel,
} from "../src/transforms-openai.js";

const parse = (b: unknown) => JSON.parse(b as string);

describe("normalizeCodexModel", () => {
  it("returns the gpt-5.2 fallback for empty/undefined input", () => {
    expect(normalizeCodexModel(undefined)).toBe("gpt-5.2");
    expect(normalizeCodexModel("")).toBe("gpt-5.2");
    expect(normalizeCodexModel("   ")).toBe("gpt-5.2");
  });

  it("strips a provider prefix", () => {
    expect(normalizeCodexModel("openai/gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeCodexModel("anthropic/claude-opus-4-7")).toBe(
      "claude-opus-4-7",
    );
  });

  it("trims whitespace", () => {
    expect(normalizeCodexModel("  gpt-5.5  ")).toBe("gpt-5.5");
  });

  it("passes plain IDs through unchanged", () => {
    // Verified against a live ChatGPT Plus account: rewriting these names is
    // what previously broke the integration. Keep this contract.
    expect(normalizeCodexModel("gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeCodexModel("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeCodexModel("gpt-5-codex")).toBe("gpt-5-codex");
  });
});

describe("transformCodexOAuthBody", () => {
  it("returns non-string bodies unchanged", () => {
    expect(transformCodexOAuthBody(undefined)).toBeUndefined();
    const obj = { foo: "bar" };
    expect(transformCodexOAuthBody(obj)).toBe(obj);
  });

  it("returns invalid JSON unchanged", () => {
    const garbage = "not json {{";
    expect(transformCodexOAuthBody(garbage)).toBe(garbage);
  });

  it("forces store:false and strips sampling params", () => {
    const out = transformCodexOAuthBody(
      JSON.stringify({
        model: "gpt-5.5",
        store: true,
        temperature: 0,
        top_p: 0.9,
        input: [{ role: "user", content: "hi" }],
      }),
    );
    const obj = parse(out);
    expect(obj.store).toBe(false);
    expect(obj.temperature).toBeUndefined();
    expect(obj.top_p).toBeUndefined();
  });

  it("hoists developer-role content to top-level instructions and removes it from input", () => {
    const out = transformCodexOAuthBody(
      JSON.stringify({
        model: "gpt-5.5",
        input: [
          { role: "developer", content: "be helpful" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    const obj = parse(out);
    expect(obj.instructions).toBe("be helpful");
    expect(obj.input).toHaveLength(1);
    expect(obj.input[0].role).toBe("user");
  });

  it("hoists system-role content to top-level instructions", () => {
    const out = transformCodexOAuthBody(
      JSON.stringify({ input: [{ role: "system", content: "be terse" }] }),
    );
    expect(parse(out).instructions).toBe("be terse");
  });

  it("flattens content-array text parts when hoisting", () => {
    const out = transformCodexOAuthBody(
      JSON.stringify({
        input: [
          {
            role: "developer",
            content: [
              { type: "text", text: "part one " },
              { type: "text", text: "part two" },
            ],
          },
        ],
      }),
    );
    expect(parse(out).instructions).toBe("part one part two");
  });

  it("concatenates hoisted text with pre-existing top-level instructions", () => {
    const out = transformCodexOAuthBody(
      JSON.stringify({
        instructions: "outer",
        input: [{ role: "developer", content: "inner" }],
      }),
    );
    expect(parse(out).instructions).toBe("outer\n\ninner");
  });

  it("falls back to default instructions when none are present", () => {
    // The ChatGPT backend rejects requests with empty/missing instructions.
    const out = transformCodexOAuthBody(JSON.stringify({ input: [] }));
    expect(parse(out).instructions).toBe("You are a helpful assistant.");
  });

  it("normalizes the model field", () => {
    const out = transformCodexOAuthBody(
      JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
    );
    expect(parse(out).model).toBe("gpt-5.5");
  });
});
