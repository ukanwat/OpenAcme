import { z } from "zod";
import { registry } from "../../registry.js";
import { getCurrentAgentId } from "../../session-context.js";
import {
  getBrowserBindings,
  notBoundError,
  requireAgentIdOr,
  toolError,
} from "./bindings.js";

const SnapshotParams = z.object({
  tabId: z
    .string()
    .optional()
    .describe("Tab id; defaults to the agent's active tab."),
});

registry.register({
  name: "browser_snapshot",
  toolset: "browser",
  emoji: "📸",
  parallelSafe: true,
  description:
    "Capture the current page's aria-snapshot — a compact YAML tree of interactive + structural elements with [ref=eN] ids. Use the ref ids to target elements in browser_click, browser_type, browser_act, etc. Call again after any interaction that changes the page (snapshots can go stale).",
  parameters: SnapshotParams,
  maxResultSizeChars: 12_000,
  handler: async (args) => {
    const p = args as z.infer<typeof SnapshotParams>;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_snapshot");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_snapshot", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.snapshot(agentId!, { tabId: p.tabId });
      return JSON.stringify(r);
    } catch (e) {
      return toolError("browser_snapshot", e);
    }
  },
});
