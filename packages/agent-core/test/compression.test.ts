import { describe, it, expect } from "vitest";
import type { Message } from "@openacme/db";
import {
  contentLengthForBudget,
  messageBudgetLength,
  summarizeToolResult,
  truncateToolCallArgs,
  dedupeToolResults,
  pruneOldToolResults,
  alignBoundaryBackward,
  alignBoundaryForward,
  findLastUserMessageIdx,
  ensureLastUserMessageInTail,
  findTailCutByTokens,
  sanitizeToolPairs,
  buildSummaryPrompt,
  serializeForSummary,
  withSummaryPrefix,
  resolveThreshold,
  IMAGE_CHAR_EQUIVALENT,
  SUMMARY_PREFIX,
} from "../src/compression.js";
import type { CompressionConfig } from "../src/types.js";

function msg(
  role: Message["role"],
  content: string | null,
  extras: Partial<Message> = {}
): Message {
  return {
    id: extras.id ?? `m-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: extras.sessionId ?? "s",
    role,
    content,
    toolCalls: extras.toolCalls ?? null,
    toolCallId: extras.toolCallId ?? null,
    toolName: extras.toolName ?? null,
    createdAt: extras.createdAt ?? 0,
  };
}

describe("contentLengthForBudget", () => {
  it("returns string length for plain string content", () => {
    expect(contentLengthForBudget("hello")).toBe(5);
  });

  it("counts image parts at IMAGE_CHAR_EQUIVALENT", () => {
    const len = contentLengthForBudget([
      { type: "text", text: "hi" },
      { type: "image", image: "base64data" },
    ]);
    expect(len).toBe(2 + IMAGE_CHAR_EQUIVALENT);
  });

  it("counts file parts at IMAGE_CHAR_EQUIVALENT", () => {
    const len = contentLengthForBudget([
      { type: "file", data: "blah", mediaType: "application/pdf" },
    ]);
    expect(len).toBe(IMAGE_CHAR_EQUIVALENT);
  });

  it("counts tool-call args via JSON.stringify", () => {
    const len = contentLengthForBudget([
      { type: "tool-call", toolCallId: "1", toolName: "shell", args: { cmd: "ls" } },
    ]);
    expect(len).toBe(JSON.stringify({ cmd: "ls" }).length);
  });

  it("counts tool-result text or stringified value", () => {
    expect(
      contentLengthForBudget([
        { type: "tool-result", toolCallId: "1", toolName: "shell", result: "abc" },
      ])
    ).toBe(3);
    expect(
      contentLengthForBudget([
        { type: "tool-result", toolCallId: "1", toolName: "shell", result: { ok: true } },
      ])
    ).toBe(JSON.stringify({ ok: true }).length);
  });

  it("returns 0 for null/undefined", () => {
    expect(contentLengthForBudget(null)).toBe(0);
    expect(contentLengthForBudget(undefined)).toBe(0);
  });

  it("ignores unknown part types (forward-compatible)", () => {
    expect(
      contentLengthForBudget([{ type: "future-part", payload: "xyz" }])
    ).toBe(0);
  });
});

describe("messageBudgetLength", () => {
  // Per-message overhead is 10 tokens (matches Hermes context_compressor.py:1185)
  // expressed in chars: 10 tokens × 4 chars/token = 40.
  const OVERHEAD = 40;

  it("sums content + toolCalls + per-message overhead", () => {
    const m = msg("assistant", "abc", { toolCalls: '[{"a":1}]' });
    expect(messageBudgetLength(m)).toBe(3 + '[{"a":1}]'.length + OVERHEAD);
  });

  it("handles null content", () => {
    expect(messageBudgetLength(msg("assistant", null))).toBe(OVERHEAD);
  });
});

describe("summarizeToolResult", () => {
  it("formats shell with command and line count", () => {
    expect(
      summarizeToolResult("shell", { command: "ls -la" }, "a\nb\nc")
    ).toBe("[shell] $ ls -la → 3 lines");
  });

  it("formats read_file with path and char count", () => {
    expect(
      summarizeToolResult("read_file", { path: "a.ts" }, "x".repeat(1234))
    ).toBe("[read_file] a.ts (1234 chars)");
  });

  it("formats write_file with path and wrote-chars", () => {
    expect(
      summarizeToolResult("write_file", { path: "out.txt", content: "hello" }, "ok")
    ).toBe("[write_file] out.txt (wrote 5 chars)");
  });

  it("formats edit with replacement line count", () => {
    expect(
      summarizeToolResult("edit", { path: "a.ts", replacement: "x\ny" }, "ok")
    ).toBe("[edit] a.ts (replaced 2 lines)");
  });

  it("formats apply_patch with patch line count", () => {
    expect(
      summarizeToolResult("apply_patch", { patch: "@@\n-a\n+b" }, "ok")
    ).toBe("[apply_patch] 3 patch lines");
  });

  it("formats list_files with entry count", () => {
    expect(
      summarizeToolResult("list_files", { path: "." }, "a.ts\nb.ts\nc.ts")
    ).toBe("[list_files] . (3 entries)");
  });

  it("formats search_files with match count via :line: heuristic", () => {
    expect(
      summarizeToolResult(
        "search_files",
        { query: "foo", path: "src" },
        "src/a.ts:10:foo\nsrc/b.ts:42:foo"
      )
    ).toBe("[search_files] 'foo' in src (2 matches)");
  });

  it("formats web_search with [N] result-count heuristic", () => {
    expect(
      summarizeToolResult("web_search", { query: "openacme" }, "[1] hit\n[2] hit")
    ).toBe("[web_search] 'openacme' (2 results)");
  });

  it("falls back to generic for unknown tools", () => {
    expect(summarizeToolResult("custom_tool", {}, "x".repeat(50))).toBe(
      "[custom_tool] (50 chars result)"
    );
  });

  it("uses safe defaults for missing args", () => {
    expect(summarizeToolResult("read_file", {}, "abc")).toBe(
      "[read_file] ? (3 chars)"
    );
  });

  it("parses string-encoded args", () => {
    expect(
      summarizeToolResult("shell", JSON.stringify({ command: "echo hi" }), "hi")
    ).toBe("[shell] $ echo hi → 1 lines");
  });
});

describe("truncateToolCallArgs", () => {
  it("returns input unchanged when args are small", () => {
    const input = JSON.stringify([
      { toolCallId: "1", toolName: "shell", args: { command: "ls" } },
    ]);
    expect(truncateToolCallArgs(input)).toBe(input);
  });

  it("truncates long string leaves while preserving JSON validity", () => {
    const big = "x".repeat(50_000);
    const input = JSON.stringify([
      { toolCallId: "1", toolName: "write_file", args: { path: "a.ts", content: big } },
    ]);
    const out = truncateToolCallArgs(input);
    expect(out).not.toBe(input);
    // Must remain valid JSON.
    const parsed = JSON.parse(out!) as Array<{ args: { content: string; path: string } }>;
    expect(parsed[0]!.args.content.length).toBeLessThan(big.length);
    expect(parsed[0]!.args.content.endsWith("...[truncated]")).toBe(true);
    expect(parsed[0]!.args.path).toBe("a.ts");
  });

  it("preserves non-string leaves", () => {
    const input = JSON.stringify([
      {
        toolCallId: "1",
        toolName: "tool",
        args: {
          n: 42,
          ok: true,
          nada: null,
          deep: { msg: "x".repeat(1000) },
        },
      },
    ]);
    const out = truncateToolCallArgs(input);
    const parsed = JSON.parse(out!) as Array<{ args: { n: number; ok: boolean; nada: null; deep: { msg: string } } }>;
    expect(parsed[0]!.args.n).toBe(42);
    expect(parsed[0]!.args.ok).toBe(true);
    expect(parsed[0]!.args.nada).toBeNull();
    expect(parsed[0]!.args.deep.msg.endsWith("...[truncated]")).toBe(true);
  });

  it("returns input unchanged on malformed JSON", () => {
    expect(truncateToolCallArgs("not-json")).toBe("not-json");
  });

  it("handles null/empty inputs", () => {
    expect(truncateToolCallArgs(null)).toBeNull();
    expect(truncateToolCallArgs("")).toBe("");
  });
});

describe("dedupeToolResults", () => {
  it("replaces older duplicates of the same tool result content", () => {
    const long = "x".repeat(500);
    const messages = [
      msg("user", "first"),
      msg("tool", long, { toolCallId: "t1", toolName: "read_file" }),
      msg("user", "second"),
      msg("tool", long, { toolCallId: "t2", toolName: "read_file" }),
      msg("user", "third"),
      msg("tool", long, { toolCallId: "t3", toolName: "read_file" }),
    ];
    const { messages: out, deduped } = dedupeToolResults(messages);
    expect(deduped).toBe(2);
    // Newest stays full, older two replaced.
    expect(out[5]!.content).toBe(long);
    expect(out[3]!.content).toContain("Duplicate");
    expect(out[1]!.content).toContain("Duplicate");
  });

  it("does not dedupe content shorter than the threshold", () => {
    const messages = [
      msg("tool", "tiny", { toolCallId: "1", toolName: "x" }),
      msg("tool", "tiny", { toolCallId: "2", toolName: "x" }),
    ];
    const { deduped } = dedupeToolResults(messages);
    expect(deduped).toBe(0);
  });

  it("skips already-pruned placeholder content", () => {
    const messages = [
      msg("tool", "[Old tool output cleared to save context space]", {
        toolCallId: "1",
        toolName: "x",
      }),
      msg("tool", "[Old tool output cleared to save context space]", {
        toolCallId: "2",
        toolName: "x",
      }),
    ];
    const { deduped } = dedupeToolResults(messages);
    expect(deduped).toBe(0);
  });
});

describe("pruneOldToolResults", () => {
  it("replaces tool results in the prune region with 1-liners", () => {
    const messages = [
      msg("user", "go"),
      msg("assistant", null, {
        toolCalls: JSON.stringify([
          { toolCallId: "t1", toolName: "shell", args: { command: "ls" } },
        ]),
      }),
      msg("tool", "long line\n".repeat(50), {
        toolCallId: "t1",
        toolName: "shell",
      }),
      msg("user", "tail"),
    ];
    const { messages: out, pruned } = pruneOldToolResults(messages, {
      pruneBoundary: 3,
    });
    expect(pruned).toBe(1);
    expect(out[2]!.content).toMatch(/\[shell\]/);
  });

  it("leaves the protected tail untouched", () => {
    const long = "y".repeat(500);
    const messages = [
      msg("user", "go"),
      msg("tool", long, { toolCallId: "t1", toolName: "read_file" }),
      msg("tool", long, { toolCallId: "t2", toolName: "read_file" }),
    ];
    const { messages: out } = pruneOldToolResults(messages, {
      pruneBoundary: 1, // only protects nothing past index 0
    });
    // Indices 1+ are out of prune region (boundary=1 → prune [0,1))
    expect(out[1]!.content).toBe(long);
    expect(out[2]!.content).toBe(long);
  });

  it("truncates long tool-call args in the prune region", () => {
    const big = "z".repeat(50_000);
    const toolCallsJson = JSON.stringify([
      { toolCallId: "t1", toolName: "write_file", args: { path: "a", content: big } },
    ]);
    const messages = [
      msg("assistant", null, { toolCalls: toolCallsJson }),
      msg("tool", "ok", { toolCallId: "t1", toolName: "write_file" }),
      msg("user", "next"),
    ];
    const { messages: out } = pruneOldToolResults(messages, {
      pruneBoundary: 2,
    });
    const parsed = JSON.parse(out[0]!.toolCalls!) as Array<{
      args: { content: string };
    }>;
    expect(parsed[0]!.args.content.length).toBeLessThan(big.length);
  });

  it("size filter alone protects 1-liners from re-pruning on multi-pass", () => {
    // Realistic 1-liners are short (<200 chars). On a second compression
    // pass, the size filter `length <= SIGNIFICANT_TOOL_RESULT_CHARS`
    // skips them — no separate "is it a 1-liner?" detector needed.
    const oneLiner = "[read_file] /etc/hosts (412 chars)"; // ~36 chars
    const messages = [
      msg("user", "u"),
      msg("assistant", null, {
        toolCalls: JSON.stringify([
          { toolCallId: "t1", toolName: "read_file", args: { path: "/etc/hosts" } },
        ]),
      }),
      msg("tool", oneLiner, { toolCallId: "t1", toolName: "read_file" }),
      msg("user", "tail"),
    ];
    const { messages: out, pruned } = pruneOldToolResults(messages, {
      pruneBoundary: 3,
    });
    expect(pruned).toBe(0);
    expect(out[2]!.content).toBe(oneLiner);
  });
});

describe("alignBoundaryBackward / alignBoundaryForward", () => {
  // Behavior: when idx-1 is a tool message (or is preceded by a chain of
  // tool messages back to an assistant with toolCalls), pull idx back to
  // the assistant. This puts the entire group on the tail side of the cut
  // (since `tail = messages[idx:]`) rather than splitting it.
  const messages = [
    msg("user", "u1"),
    msg("assistant", "a-plain"), // 1: no tool calls
    msg("user", "u2"),
    msg("assistant", null, {
      // 3: assistant with tool call
      toolCalls: JSON.stringify([{ toolCallId: "t1", toolName: "x", args: {} }]),
    }),
    msg("tool", "r", { toolCallId: "t1", toolName: "x" }), // 4
    msg("user", "u3"),
  ];

  it("idx after a tool group → pulls back to the assistant (group stays in tail)", () => {
    // idx=5: walk check=4 (tool) → check=3 (assistant w/ tc) → return 3.
    expect(alignBoundaryBackward(messages, 5)).toBe(3);
  });

  it("idx mid-group → pulls back to the assistant", () => {
    // idx=4: check=3 (assistant w/ tc) → return 3.
    expect(alignBoundaryBackward(messages, 4)).toBe(3);
  });

  it("idx after a non-tool-group message → unchanged", () => {
    // idx=3: check=2 (user) → no walk → return 3.
    expect(alignBoundaryBackward(messages, 3)).toBe(3);
    // idx=2: check=1 (assistant, no tc) → return 2.
    expect(alignBoundaryBackward(messages, 2)).toBe(2);
  });

  it("alignBoundaryForward slides past consecutive tool messages", () => {
    const m = [
      msg("tool", "r1", { toolCallId: "t1", toolName: "x" }),
      msg("tool", "r2", { toolCallId: "t2", toolName: "x" }),
      msg("user", "u1"),
    ];
    expect(alignBoundaryForward(m, 0)).toBe(2);
  });
});

describe("findLastUserMessageIdx / ensureLastUserMessageInTail", () => {
  const history = [
    msg("system", "sys"),
    msg("user", "u1"),
    msg("assistant", "a1"),
    msg("user", "u2"),
    msg("assistant", "a2"),
  ];

  it("findLastUserMessageIdx returns idx of newest user msg", () => {
    expect(findLastUserMessageIdx(history, 0)).toBe(3);
  });

  it("ensureLastUserMessageInTail keeps already-tail-included as-is", () => {
    // cutIdx=3 → tail [u2, a2] includes the last user.
    expect(ensureLastUserMessageInTail(history, 3, 0)).toBe(3);
  });

  it("ensureLastUserMessageInTail pulls cutIdx back when last user is in summarizable region", () => {
    // cutIdx=4 → tail = [a2] only; last user (idx 3) was summarized away.
    // Pull back to idx 3.
    expect(ensureLastUserMessageInTail(history, 4, 0)).toBe(3);
  });

  it("ensureLastUserMessageInTail does not silently advance past the user when lastUserIdx == headEnd", () => {
    // Edge case: the latest user message lives right at the head boundary.
    // Naive `Math.max(lastUserIdx, headEnd + 1)` would return headEnd+1 and
    // re-orphan the user into summarizable. We must return lastUserIdx so
    // the compressor's `headEnd >= cutEnd` no-op branch fires cleanly.
    const h = [
      msg("system", "sys"),
      msg("user", "u-at-head-boundary"),
      msg("assistant", "a1"),
      msg("assistant", "a2"),
      msg("assistant", "a3"),
    ];
    // headEnd=1 → user at idx 1 IS the latest user. cutIdx=2 puts the
    // user in summarizable. ensure must pull cutIdx back to lastUserIdx=1.
    expect(ensureLastUserMessageInTail(h, 2, 1)).toBe(1);
  });
});

describe("findTailCutByTokens", () => {
  it("returns headEnd+1 when budget protects everything (small history)", () => {
    const messages = [
      msg("user", "u"),
      msg("assistant", "a"),
      msg("user", "u2"),
      msg("assistant", "a2"),
    ];
    const cut = findTailCutByTokens(messages, {
      headEnd: 1,
      tailTokenBudget: 1_000_000,
    });
    // Forced cut after head so compression has *something* to compress.
    expect(cut).toBeGreaterThanOrEqual(2);
    expect(cut).toBeLessThanOrEqual(messages.length);
  });

  it("anchors tail to the last user message", () => {
    const big = "z".repeat(200_000); // far over budget
    const messages = [
      msg("user", "u1"),
      msg("user", "u2"),
      msg("assistant", big),
      msg("user", "u3"),
      msg("assistant", "tiny"),
    ];
    const cut = findTailCutByTokens(messages, {
      headEnd: 0,
      tailTokenBudget: 100,
    });
    // u3 must end up in the tail (idx 3).
    expect(cut).toBeLessThanOrEqual(3);
  });

  it("returns ≤ headEnd when the latest user message lives at the head boundary (no-op signal)", () => {
    // Latest user is at idx 1 (== headEnd). The user-anchor pull-back
    // returns 1 (≤ headEnd). Compressor.compress treats `cutEnd ≤ headEnd`
    // as a no-op — better than putting the active task into summarizable.
    const messages = [
      msg("system", "sys"),
      msg("user", "u-at-head"),
      msg("assistant", "a1"),
      msg("assistant", "a2"),
      msg("assistant", "a3"),
      msg("assistant", "a4"),
    ];
    const cut = findTailCutByTokens(messages, {
      headEnd: 1,
      tailTokenBudget: 1_000_000, // huge → would protect everything
    });
    expect(cut).toBeLessThanOrEqual(1);
  });

  it("never splits a tool-call/result group", () => {
    const messages = [
      msg("user", "u1"),
      msg("assistant", null, {
        toolCalls: JSON.stringify([{ toolCallId: "t1", toolName: "shell", args: {} }]),
      }),
      msg("tool", "r1", { toolCallId: "t1", toolName: "shell" }),
      msg("user", "u2"),
    ];
    const cut = findTailCutByTokens(messages, {
      headEnd: 0,
      tailTokenBudget: 10,
    });
    // Tail should start at idx 1 (assistant) or later, but not at idx 2
    // (which would orphan the tool result without its parent).
    expect(cut).not.toBe(2);
  });
});

describe("sanitizeToolPairs", () => {
  it("removes orphan tool results (no matching assistant call)", () => {
    const messages = [
      msg("user", "u"),
      msg("tool", "result-without-call", { toolCallId: "ORPHAN", toolName: "x" }),
      msg("assistant", "ok"),
    ];
    const out = sanitizeToolPairs(messages);
    expect(out.length).toBe(2);
    expect(out.find((m) => m.toolCallId === "ORPHAN")).toBeUndefined();
  });

  it("inserts stub results for orphan assistant tool-calls", () => {
    const messages = [
      msg("user", "u"),
      msg("assistant", null, {
        toolCalls: JSON.stringify([
          { toolCallId: "ABANDONED", toolName: "shell", args: {} },
        ]),
      }),
      // No tool result follows.
      msg("user", "next"),
    ];
    const out = sanitizeToolPairs(messages);
    // Stub inserted between assistant and next user.
    expect(out.length).toBe(4);
    expect(out[2]!.role).toBe("tool");
    expect(out[2]!.toolCallId).toBe("ABANDONED");
    expect(out[2]!.content).toContain("earlier conversation");
  });

  it("handles both kinds in one pass", () => {
    const messages = [
      msg("tool", "orphan-result", { toolCallId: "X1", toolName: "x" }),
      msg("assistant", null, {
        toolCalls: JSON.stringify([
          { toolCallId: "X2", toolName: "shell", args: {} },
        ]),
      }),
    ];
    const out = sanitizeToolPairs(messages);
    expect(out.find((m) => m.toolCallId === "X1")).toBeUndefined();
    expect(out.find((m) => m.toolCallId === "X2" && m.role === "tool")).toBeDefined();
  });

  it("leaves a healthy list unchanged", () => {
    const messages = [
      msg("assistant", null, {
        toolCalls: JSON.stringify([
          { toolCallId: "T", toolName: "shell", args: {} },
        ]),
      }),
      msg("tool", "ok", { toolCallId: "T", toolName: "shell" }),
    ];
    const out = sanitizeToolPairs(messages);
    expect(out.length).toBe(2);
    expect(out[0]!.role).toBe("assistant");
    expect(out[1]!.role).toBe("tool");
  });
});

describe("buildSummaryPrompt / serializeForSummary / withSummaryPrefix", () => {
  it("FRESH prompt has 'TURNS TO SUMMARIZE' and no 'PREVIOUS SUMMARY'", () => {
    const p = buildSummaryPrompt({ turns: [msg("user", "hi")], summaryBudget: 2000 });
    expect(p).toContain("TURNS TO SUMMARIZE:");
    expect(p).not.toContain("PREVIOUS SUMMARY:");
    expect(p).toContain("## Active Task");
  });

  it("UPDATE prompt includes both PREVIOUS SUMMARY and NEW TURNS", () => {
    const p = buildSummaryPrompt({
      turns: [msg("user", "hi")],
      previousSummary: "## Active Task\nrefactor auth",
      summaryBudget: 2000,
    });
    expect(p).toContain("PREVIOUS SUMMARY:");
    expect(p).toContain("NEW TURNS TO INCORPORATE:");
    expect(p).toContain("refactor auth");
  });

  it("serializeForSummary labels each role", () => {
    const out = serializeForSummary([
      msg("user", "hello"),
      msg("assistant", "hi back"),
      msg("tool", "result", { toolCallId: "T1", toolName: "shell" }),
    ]);
    expect(out).toContain("[USER]:");
    expect(out).toContain("[ASSISTANT]:");
    expect(out).toContain("[TOOL T1]:");
  });

  it("serializeForSummary truncates long content with head+sentinel+tail", () => {
    const big = "x".repeat(50_000);
    const out = serializeForSummary([msg("assistant", big)]);
    expect(out).toContain("...[truncated]...");
    expect(out.length).toBeLessThan(big.length);
  });

  it("serializeForSummary renders [Tool calls: ...] for assistant with toolCalls", () => {
    const out = serializeForSummary([
      msg("assistant", "calling", {
        toolCalls: JSON.stringify([
          { toolCallId: "1", toolName: "shell", args: { command: "ls" } },
        ]),
      }),
    ]);
    expect(out).toContain("[Tool calls:");
    expect(out).toContain("shell(");
  });

  it("withSummaryPrefix prepends the prefix", () => {
    const wrapped = withSummaryPrefix("body");
    expect(wrapped.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(wrapped).toContain("body");
  });

  it("withSummaryPrefix is idempotent", () => {
    const once = withSummaryPrefix("body");
    const twice = withSummaryPrefix(once);
    expect(twice).toBe(once);
  });
});

describe("resolveThreshold", () => {
  const baseConfig: CompressionConfig = {
    thresholdTokens: null,
    thresholdPercent: 0.5,
    contextWindow: 200_000,
    protectFirstN: 3,
    tailTokenBudget: 20_000,
    summaryTargetRatio: 0.2,
    summarizerInputCharBudget: 80_000,
  };

  it("absolute thresholdTokens wins over percent", () => {
    expect(
      resolveThreshold({ ...baseConfig, thresholdTokens: 7777 })
    ).toBe(7777);
  });

  it("percent × contextWindow when both set", () => {
    expect(resolveThreshold(baseConfig)).toBe(100_000);
    expect(
      resolveThreshold({ ...baseConfig, contextWindow: 1_000_000 })
    ).toBe(500_000);
  });

  it("percent without contextWindow → null (registry didn't have the model)", () => {
    expect(
      resolveThreshold({ ...baseConfig, contextWindow: null })
    ).toBeNull();
  });

  it("returns null when all trigger fields are null (proactive disabled)", () => {
    expect(
      resolveThreshold({
        ...baseConfig,
        thresholdTokens: null,
        thresholdPercent: null,
        contextWindow: null,
      })
    ).toBeNull();
  });
});
