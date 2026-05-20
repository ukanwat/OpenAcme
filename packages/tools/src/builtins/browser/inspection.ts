import { z } from "zod";
import { registry } from "../../registry.js";
import { getCurrentAgentId } from "../../session-context.js";
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
  // base64 PNG isn't grep-friendly — skip spill-to-file, the bytes go
  // straight to the model as an image.
  binaryResult: true,
  description:
    "Capture a PNG screenshot of the current page. Returns base64-encoded PNG. Use when text snapshots miss the relevant visual (captchas, image content, complex layouts) — vision-capable models will see the image directly.",
  parameters: ScreenshotParams,
  handler: async (args) => {
    const p = args as z.infer<typeof ScreenshotParams>;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_take_screenshot");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_take_screenshot", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.takeScreenshot(agentId!, p);
      return JSON.stringify(r);
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
