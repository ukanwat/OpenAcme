import { z } from "zod";
import { registry } from "../../registry.js";
import { getCurrentAgentId } from "../../session-context.js";
import {
  getBrowserBindings,
  notBoundError,
  requireAgentIdOr,
  toolError,
} from "./bindings.js";

/**
 * Single-object schema (no discriminated union) because Anthropic's tool API
 * rejects top-level `oneOf` / `anyOf`. Per-action requirements are enforced
 * via `superRefine`. Mirrors the `memory` tool's pattern.
 */
const TabsParams = z
  .object({
    action: z
      .enum(["list", "new", "close", "select"])
      .describe("Tab operation to perform."),
    url: z
      .string()
      .optional()
      .describe("action=new: optional URL to navigate the new tab to."),
    tabId: z
      .string()
      .optional()
      .describe(
        "Tab id (e.g. 't2'). Required for action=close / action=select."
      ),
  })
  .superRefine((v, ctx) => {
    if ((v.action === "close" || v.action === "select") && !v.tabId) {
      ctx.addIssue({
        code: "custom",
        path: ["tabId"],
        message: `tabId is required for action=${v.action}`,
      });
    }
  });

type TabsArgs = z.infer<typeof TabsParams>;

registry.register({
  name: "browser_tabs",
  toolset: "browser",
  emoji: "🗂️",
  parallelSafe: false,
  description:
    "Manage this agent's browser tabs: list owned tabs, open a new one, close one, or focus one. Each agent only sees its own tabs (cookies/login state are shared across the fleet, but tabs are not). Use the returned tabId in subsequent browser_* calls.",
  parameters: TabsParams,
  handler: async (args) => {
    const p = args as TabsArgs;
    const b = getBrowserBindings();
    if (!b) return notBoundError("browser_tabs");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("browser_tabs", agentId);
    if (guard) return guard;
    try {
      switch (p.action) {
        case "list": {
          const tabs = await b.manager.tabsList(agentId!);
          return JSON.stringify({ tabs });
        }
        case "new": {
          const tab = await b.manager.tabsNew(agentId!, { url: p.url });
          return JSON.stringify(tab);
        }
        case "close": {
          await b.manager.tabsClose(agentId!, { tabId: p.tabId! });
          return JSON.stringify({ closed: p.tabId });
        }
        case "select": {
          const tab = await b.manager.tabsSelect(agentId!, {
            tabId: p.tabId!,
          });
          return JSON.stringify(tab);
        }
      }
    } catch (e) {
      return toolError("browser_tabs", e);
    }
  },
});
