import { z } from "zod";
import { registry } from "../../registry.js";
import { getCurrentAgentId } from "../../session-context.js";
import {
  getBrowserBindings,
  notBoundError,
  requireAgentIdOr,
  spillSnapshotField,
  toolError,
} from "./bindings.js";

const ClickParams = z.object({
  element: z
    .string()
    .min(1)
    .describe(
      "Human-readable description of the element being clicked (for the model's own log)."
    ),
  ref: z
    .string()
    .min(1)
    .describe(
      "Playwright locator string. For snapshot refs use 'aria-ref=eN' (e.g. 'aria-ref=e3' from a browser_snapshot [ref=e3] marker). Or any other Playwright selector: 'css=button.submit', 'role=button[name=\"Send\"]', 'text=Sign in', 'data-testid=...', 'xpath=...'."
    ),
  tabId: z.string().optional(),
});

registry.register({
  name: "browser_click",
  toolset: "browser",
  emoji: "🖱️",
  parallelSafe: false,
  description:
    "Click an element. Pass `element` as a short human description and `ref` as any Playwright locator (typically 'aria-ref=eN' from a recent browser_snapshot, but CSS / role / text / data-testid / xpath all work).",
  parameters: ClickParams,
  handler: async (args) => {
    const p = args as z.infer<typeof ClickParams>;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_click");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_click", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.click(agentId!, p);
      return JSON.stringify(spillSnapshotField(r));
    } catch (e) {
      return toolError("browser_click", e);
    }
  },
});

const TypeParams = z.object({
  element: z.string().min(1),
  ref: z
    .string()
    .min(1)
    .describe(
      "Playwright locator string. For snapshot refs use 'aria-ref=eN'. Or any other Playwright selector: 'css=textarea', 'role=textbox[name=\"Comment\"]', 'data-testid=...', etc."
    ),
  text: z.string().describe("Text to type into the field."),
  submit: z
    .boolean()
    .optional()
    .describe("Press Enter after typing (submits forms)."),
  tabId: z.string().optional(),
});

registry.register({
  name: "browser_type",
  toolset: "browser",
  emoji: "⌨️",
  parallelSafe: false,
  description:
    "Type text into an input field. `ref` is any Playwright locator (typically 'aria-ref=eN' from a recent browser_snapshot). Clears existing content first. Set submit=true to press Enter after typing.",
  parameters: TypeParams,
  handler: async (args) => {
    const p = args as z.infer<typeof TypeParams>;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_type");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_type", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.type(agentId!, p);
      return JSON.stringify(spillSnapshotField(r));
    } catch (e) {
      return toolError("browser_type", e);
    }
  },
});

const PressKeyParams = z.object({
  key: z
    .string()
    .min(1)
    .describe(
      "Key name (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Control+a')."
    ),
  tabId: z.string().optional(),
});

registry.register({
  name: "browser_press_key",
  toolset: "browser",
  emoji: "🔑",
  parallelSafe: false,
  description:
    "Press a keyboard key (or combo) on the page. Useful for keyboard navigation, dismissing menus, or submitting forms outside text inputs.",
  parameters: PressKeyParams,
  handler: async (args) => {
    const p = args as z.infer<typeof PressKeyParams>;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_press_key");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_press_key", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.pressKey(agentId!, p);
      return JSON.stringify(spillSnapshotField(r));
    } catch (e) {
      return toolError("browser_press_key", e);
    }
  },
});
