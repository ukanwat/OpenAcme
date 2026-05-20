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

const NavigateParams = z.object({
  url: z.string().min(1).describe("Absolute URL to navigate to."),
  tabId: z
    .string()
    .optional()
    .describe(
      "Tab id from a previous browser_* call. If omitted, navigates the agent's active tab (or opens a new one)."
    ),
});

registry.register({
  name: "browser_navigate",
  toolset: "browser",
  emoji: "🌐",
  parallelSafe: false,
  description:
    "Navigate the browser to a URL. If no tabId is given, opens a new tab for this agent (or reuses the active one). Returns the resolved URL, page title, and a path to the post-navigation aria-snapshot YAML (read_file / search_files to inspect; [ref=eN] markers translate to 'aria-ref=eN' Playwright selectors for click/type). Use browser_* tools for pages that need interaction, login state, or JS rendering; prefer web_search / web_extract for static info retrieval.",
  parameters: NavigateParams,
  handler: async (args) => {
    const p = args as z.infer<typeof NavigateParams>;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_navigate");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_navigate", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.navigate(agentId!, {
        url: p.url,
        tabId: p.tabId,
      });
      return JSON.stringify(spillSnapshotField(r));
    } catch (e) {
      return toolError("browser_navigate", e);
    }
  },
});
