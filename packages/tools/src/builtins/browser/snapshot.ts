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

const SnapshotParams = z.object({
  tabId: z
    .string()
    .optional()
    .describe("Tab id; defaults to the agent's active tab."),
  selector: z
    .string()
    .optional()
    .describe(
      "Optional Playwright locator string to scope the snapshot to a subtree (e.g. 'form[data-testid=\"reply\"]', 'role=main', '#sidebar'). Use when the whole-page snapshot doesn't reach the element you need — chrome, ads, and other unrelated regions are excluded so the target fits in the result. Omit to snapshot the full <body>."
    ),
});

registry.register({
  name: "browser_snapshot",
  toolset: "browser",
  emoji: "📸",
  parallelSafe: true,
  description:
    "Capture the current page's aria-snapshot — a compact YAML tree of interactive + structural elements with [ref=eN] ids. Pass those ids to browser_click/browser_type/browser_act as 'aria-ref=eN' Playwright selectors (or use any other Playwright locator: 'css=…', 'role=…', 'text=…', 'data-testid=…', 'xpath=…'). Call again after any interaction that changes the page (snapshots can go stale). Use `selector` to scope to a subtree when the full page exceeds the snapshot budget.",
  parameters: SnapshotParams,
  handler: async (args) => {
    const p = args as z.infer<typeof SnapshotParams>;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_snapshot");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_snapshot", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.snapshot(agentId!, {
        tabId: p.tabId,
        selector: p.selector,
      });
      return JSON.stringify(spillSnapshotField(r));
    } catch (e) {
      return toolError("browser_snapshot", e);
    }
  },
});
