import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { registry } from "../../registry.js";
import {
  getCurrentAgentId,
  getCurrentSessionId,
  getCurrentToolCallId,
} from "../../session-context.js";
import { resolveToolCallsDir } from "../../spill.js";
import { buildMediaToolModelOutput } from "../file.js";
import {
  getBrowserBindings,
  notBoundError,
  requireAgentIdOr,
  toolError,
} from "./bindings.js";

const ScreenshotParams = z.object({
  fullPage: z
    .boolean()
    .optional()
    .describe("Capture the full scrollable page, not just the viewport."),
  tabId: z.string().optional(),
});

registry.register({
  name: "browser_take_screenshot",
  toolset: "browser",
  emoji: "🖼️",
  parallelSafe: false,
  description:
    "Capture a PNG screenshot of the current page and save it to the session's tool-calls dir. " +
    "Returns the file path; the bytes are delivered as a vision input on multimodal models " +
    "(inline in the tool result on Anthropic / OpenAI Responses / Google; via a synthetic user " +
    "message on OpenRouter / OpenAI Chat Completions). Use when text snapshots miss the relevant " +
    "visual (captchas, image content, complex layouts).",
  parameters: ScreenshotParams,
  toModelOutput: buildMediaToolModelOutput,
  handler: async (args) => {
    const p = args as z.infer<typeof ScreenshotParams>;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_take_screenshot");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_take_screenshot", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.takeScreenshot(agentId!, p);
      const bytes = Buffer.from(r.pngBase64, "base64");
      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .replace("Z", "");
      const baseFilename = `screenshot-${ts}-${r.tabId}.png`;

      // Save under the session's tool-calls dir, prefixed with the
      // toolCallId so the `/api/tool-files/...` route can resolve and
      // serve it. Flat naming (no subdir) keeps the existing
      // sweepOverflow / deleteSessionToolCalls cleanup intact.
      const dir = resolveToolCallsDir();
      if (!dir) return JSON.stringify(r);
      const sessionId = getCurrentSessionId();
      const callId = getCurrentToolCallId();
      fs.mkdirSync(dir, { recursive: true });
      const onDiskName = callId ? `${callId}-${baseFilename}` : baseFilename;
      const absPath = path.join(dir, onDiskName);
      fs.writeFileSync(absPath, bytes);
      const url =
        sessionId && callId
          ? `/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(callId)}/${encodeURIComponent(baseFilename)}`
          : undefined;
      return JSON.stringify({
        success: true,
        tabId: r.tabId,
        path: absPath,
        mediaType: r.mediaType,
        bytes: bytes.length,
        _media: "image",
        ...(url ? { url } : {}),
      });
    } catch (e) {
      return toolError("browser_take_screenshot", e);
    }
  },
});

const WaitForParams = z
  .object({
    text: z
      .string()
      .optional()
      .describe("Wait until this text is visible on the page."),
    textGone: z
      .string()
      .optional()
      .describe("Wait until this text is no longer visible on the page."),
    timeMs: z
      .number()
      .int()
      .positive()
      .max(60_000)
      .optional()
      .describe("Wait for a fixed number of milliseconds (cap 60s)."),
    tabId: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.text && !v.textGone && !v.timeMs) {
      ctx.addIssue({
        code: "custom",
        message: "Provide at least one of: text, textGone, timeMs.",
      });
    }
  });

registry.register({
  name: "browser_wait_for",
  toolset: "browser",
  emoji: "⏳",
  parallelSafe: false,
  description:
    "Wait for text to appear, text to disappear, or a fixed time. Useful for letting JS-heavy pages settle before snapshotting. Provide exactly one of: text, textGone, timeMs.",
  parameters: WaitForParams,
  handler: async (args) => {
    const p = args as z.infer<typeof WaitForParams>;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_wait_for");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_wait_for", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.waitFor(agentId!, p);
      return JSON.stringify(r);
    } catch (e) {
      return toolError("browser_wait_for", e);
    }
  },
});

const EvaluateParams = z.object({
  function: z
    .string()
    .min(1)
    .describe(
      "A JS expression OR a function/arrow that runs in the page context. Functions are auto-invoked (sync or async). Examples: 'document.title', '[...document.images].length', '() => document.querySelector(\"textarea\")?.offsetTop', '() => { const t = document.querySelector(\".x\"); return t ? t.textContent : null }', 'async () => (await fetch(\"/api\")).status'. For multi-statement code use the arrow form ('() => { ...; return X; }') — a bare statement like 'const x = ...; x.foo' isn't a valid expression. Return value is JSON-serialized; undefined comes back as null."
    ),
  tabId: z.string().optional(),
});

registry.register({
  name: "browser_evaluate",
  toolset: "browser",
  emoji: "🔬",
  parallelSafe: false,
  description:
    "Evaluate JavaScript in the page context. Use for DOM inspection, reading page state, or extracting data the aria-snapshot doesn't capture. Pass a single expression or an arrow function (see param doc for shapes).",
  parameters: EvaluateParams,
  maxResultSizeChars: 12_000,
  handler: async (args) => {
    const p = args as z.infer<typeof EvaluateParams>;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_evaluate");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_evaluate", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.evaluate(agentId!, p);
      return JSON.stringify(r);
    } catch (e) {
      return toolError("browser_evaluate", e);
    }
  },
});

const ConsoleMessagesParams = z.object({
  clear: z
    .boolean()
    .optional()
    .describe("Clear the buffer after reading."),
  tabId: z.string().optional(),
});

registry.register({
  name: "browser_console_messages",
  toolset: "browser",
  emoji: "📋",
  parallelSafe: true,
  description:
    "Return recent browser console messages (log/warn/error/info) and uncaught JavaScript errors collected on this tab. Useful for debugging silent JS failures, failed API calls, app warnings.",
  parameters: ConsoleMessagesParams,
  maxResultSizeChars: 12_000,
  handler: async (args) => {
    const p = args as z.infer<typeof ConsoleMessagesParams>;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_console_messages");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_console_messages", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.consoleMessages(agentId!, p);
      return JSON.stringify(r);
    } catch (e) {
      return toolError("browser_console_messages", e);
    }
  },
});
