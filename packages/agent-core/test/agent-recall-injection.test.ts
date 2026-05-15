import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { __test as agentTest } from "../src/agent.js";
import { __test as messagesTest } from "../src/messages.js";

const { countMessagesAfter, lastAssistantId } = agentTest;
const { materializeRecallContext } = messagesTest;

// `materializeRecallContext` is the new entry point — it walks UIMessages,
// extracts `data-relevant-memory` parts from user messages, and prepends
// their `modelContent` as a leading text part. Replaced the older
// `injectIntoLastUserMessage` (per-call, ephemeral) with this persisted-
// part materialization so subsequent turns produce byte-identical model
// input → prefix cache hits.
describe("materializeRecallContext", () => {
  const userMsg = (parts: UIMessage["parts"]): UIMessage => ({
    id: "u1",
    role: "user",
    parts,
  });

  it("prepends modelContent as a leading text part", () => {
    const out = materializeRecallContext([
      userMsg([
        { type: "text", text: "what is this?" } as UIMessage["parts"][number],
        {
          type: "data-relevant-memory",
          id: "rc1",
          data: { modelContent: "<system-reminder>recall body</system-reminder>" },
        } as unknown as UIMessage["parts"][number],
      ]),
    ]);
    expect(out[0]!.parts.length).toBe(2);
    expect((out[0]!.parts[0] as { type: string; text: string })).toEqual({
      type: "text",
      text: "<system-reminder>recall body</system-reminder>",
    });
    expect((out[0]!.parts[1] as { text: string }).text).toBe("what is this?");
  });

  it("removes the data-relevant-memory part from output", () => {
    const out = materializeRecallContext([
      userMsg([
        {
          type: "data-relevant-memory",
          id: "rc1",
          data: { modelContent: "X" },
        } as unknown as UIMessage["parts"][number],
        { type: "text", text: "y" } as UIMessage["parts"][number],
      ]),
    ]);
    const types = out[0]!.parts.map(
      (p) => (p as { type: string }).type
    );
    expect(types).not.toContain("data-relevant-memory");
  });

  it("is a no-op when no data-relevant-memory parts exist", () => {
    const input = [
      userMsg([{ type: "text", text: "hi" } as UIMessage["parts"][number]]),
    ];
    const out = materializeRecallContext(input);
    expect(out[0]!.parts).toEqual(input[0]!.parts);
  });

  it("ignores data-relevant-memory on non-user messages", () => {
    const asst: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "data-relevant-memory",
          id: "rc1",
          data: { modelContent: "wrong slot" },
        } as unknown as UIMessage["parts"][number],
        { type: "text", text: "hello" } as UIMessage["parts"][number],
      ],
    };
    const out = materializeRecallContext([asst]);
    // Assistant parts pass through unchanged
    expect(out[0]!.parts.length).toBe(2);
    expect(
      (out[0]!.parts[0] as { type: string }).type
    ).toBe("data-relevant-memory");
  });

  it("concatenates multiple data-relevant-memory parts in order", () => {
    const out = materializeRecallContext([
      userMsg([
        {
          type: "data-relevant-memory",
          id: "a",
          data: { modelContent: "first" },
        } as unknown as UIMessage["parts"][number],
        {
          type: "data-relevant-memory",
          id: "b",
          data: { modelContent: "second" },
        } as unknown as UIMessage["parts"][number],
        { type: "text", text: "user text" } as UIMessage["parts"][number],
      ]),
    ]);
    expect((out[0]!.parts[0] as { text: string }).text).toBe("first\n\nsecond");
  });

  it("skips empty modelContent strings (defensive)", () => {
    const out = materializeRecallContext([
      userMsg([
        {
          type: "data-relevant-memory",
          id: "rc",
          data: { modelContent: "" },
        } as unknown as UIMessage["parts"][number],
        { type: "text", text: "real" } as UIMessage["parts"][number],
      ]),
    ]);
    // Nothing prepended — user text is the sole text part.
    const texts = out[0]!.parts.filter(
      (p) => (p as { type: string }).type === "text"
    );
    expect(texts.length).toBe(1);
    expect((texts[0] as { text: string }).text).toBe("real");
  });

  it("does not mutate the input array", () => {
    const input = [
      userMsg([
        {
          type: "data-relevant-memory",
          id: "rc",
          data: { modelContent: "X" },
        } as unknown as UIMessage["parts"][number],
        { type: "text", text: "y" } as UIMessage["parts"][number],
      ]),
    ];
    const snapshot = JSON.stringify(input);
    materializeRecallContext(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("countMessagesAfter", () => {
  const m = (id: string) => ({ id, role: "user" as const, parts: [] });

  it("returns 0 when cursor matches the last message", () => {
    expect(countMessagesAfter([m("a"), m("b"), m("c")], "c")).toBe(0);
  });

  it("returns count strictly after the cursor", () => {
    expect(countMessagesAfter([m("a"), m("b"), m("c")], "a")).toBe(2);
  });

  it("returns full length when cursor is undefined (first run)", () => {
    expect(countMessagesAfter([m("a"), m("b")], undefined)).toBe(2);
  });

  it("returns full length when cursor is stale (post-compaction)", () => {
    // Cursor's id no longer in messages — treat all as new rather than
    // silently disabling extraction for the rest of the session.
    expect(countMessagesAfter([m("a"), m("b")], "removed-by-compaction")).toBe(2);
  });

  it("returns 0 for empty messages with cursor undefined", () => {
    expect(countMessagesAfter([], undefined)).toBe(0);
  });
});

describe("lastAssistantId", () => {
  it("returns id of the last assistant message", () => {
    expect(
      lastAssistantId([
        { id: "u1", role: "user", parts: [] },
        { id: "a1", role: "assistant", parts: [] },
        { id: "u2", role: "user", parts: [] },
        { id: "a2", role: "assistant", parts: [] },
      ])
    ).toBe("a2");
  });

  it("returns undefined when no assistant message exists", () => {
    expect(
      lastAssistantId([{ id: "u1", role: "user", parts: [] }])
    ).toBeUndefined();
  });

  it("returns undefined for empty history", () => {
    expect(lastAssistantId([])).toBeUndefined();
  });
});
