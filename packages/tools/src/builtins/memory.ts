import { z } from "zod";
import { MemoryStore, scanMemoryContent } from "@openacme/memory";
import { registry } from "../registry.js";
import { getCurrentAgentId } from "../session-context.js";

export interface MemoryBindings {
  /** Per-agent memory store, constructed by AgentManager against `<dataDir>/agents/`. */
  store: MemoryStore;
  /** Per-agent char cap, lifted from `AgentDefinition.memoryCharLimit`. */
  getCharLimit: (agentId: string) => number;
}

// Bound by AgentManager at construction time. Until then the tool returns
// a clear error rather than silently writing to a default path.
let bindings: MemoryBindings | null = null;

export function bindMemory(b: MemoryBindings): void {
  bindings = b;
}

const TOOL_DESCRIPTION =
  "Persistent memory for THIS AGENT across sessions. Entries are bounded text " +
  "stored in MEMORY.md and injected into your system prompt at the start of " +
  "every new session.\n\n" +
  "Save:\n" +
  "- User preferences (TypeScript over JS, prefers concise replies)\n" +
  "- Environment facts (OS, tools, project paths)\n" +
  "- Project conventions (formatter, line width, test command)\n" +
  "- Lessons learned (this server uses port 2222, that command needs sudo)\n" +
  "- Explicit user requests to remember\n\n" +
  "Skip:\n" +
  "- Trivial / easily-rediscovered facts\n" +
  "- Raw data dumps, log output, code blocks\n" +
  "- Session-specific ephemera\n\n" +
  "Mid-session writes do NOT update your current system prompt — they take " +
  "effect on the next session start. Tool responses always show live state.\n\n" +
  "Use 'replace'/'remove' with a SHORT UNIQUE substring (`old_text`); the " +
  "tool errors if it matches multiple entries.";

registry.register({
  name: "memory",
  toolset: "memory",
  description: TOOL_DESCRIPTION,
  parameters: z.object({
    action: z
      .enum(["add", "replace", "remove"])
      .describe("Operation: add new entry, replace existing, or remove existing."),
    content: z
      .string()
      .optional()
      .describe(
        "New content. Required for add and replace; ignored for remove."
      ),
    old_text: z
      .string()
      .optional()
      .describe(
        "Short unique substring of an existing entry. Required for replace and remove."
      ),
  }),
  emoji: "🧠",
  parallelSafe: false,
  handler: async (args) => {
    const { action, content, old_text } = args as {
      action: "add" | "replace" | "remove";
      content?: string;
      old_text?: string;
    };

    if (!bindings) {
      return JSON.stringify({
        ok: false,
        error: "memory not initialized — AgentManager must call bindMemory().",
      });
    }

    const agentId = getCurrentAgentId();
    if (!agentId) {
      return JSON.stringify({
        ok: false,
        error: "memory tool requires an active agent context.",
      });
    }

    let charLimit: number;
    try {
      charLimit = bindings.getCharLimit(agentId);
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error: `Could not resolve memory char limit: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    const { store } = bindings;

    if (action === "add") {
      if (!content || !content.trim()) {
        return JSON.stringify({
          ok: false,
          error: "content is required and must be non-empty for action='add'.",
        });
      }
      const scan = scanMemoryContent(content);
      if (!scan.ok) {
        return JSON.stringify({ ok: false, error: scan.reason });
      }
      const result = await store.add(agentId, content, charLimit);
      return JSON.stringify(formatResult(result));
    }

    if (action === "replace") {
      if (!old_text) {
        return JSON.stringify({
          ok: false,
          error: "old_text is required for action='replace'.",
        });
      }
      if (!content || !content.trim()) {
        return JSON.stringify({
          ok: false,
          error:
            "content is required for action='replace' (use 'remove' to delete an entry).",
        });
      }
      const scan = scanMemoryContent(content);
      if (!scan.ok) {
        return JSON.stringify({ ok: false, error: scan.reason });
      }
      const result = await store.replace(agentId, old_text, content, charLimit);
      return JSON.stringify(formatResult(result));
    }

    // remove
    if (!old_text) {
      return JSON.stringify({
        ok: false,
        error: "old_text is required for action='remove'.",
      });
    }
    const result = await store.remove(agentId, old_text, charLimit);
    return JSON.stringify(formatResult(result));
  },
});

function formatResult(
  r: Awaited<ReturnType<MemoryStore["add"]>>
): Record<string, unknown> {
  const usageStr = `${r.usage.used}/${r.usage.limit}`;
  if (r.ok) {
    return {
      ok: true,
      duplicate: r.duplicate ?? false,
      usage: usageStr,
      current_entries: r.usage.entries,
    };
  }
  const out: Record<string, unknown> = {
    ok: false,
    error: r.error,
    usage: usageStr,
    current_entries: r.usage.entries,
  };
  if (r.matches) out["matches"] = r.matches;
  return out;
}
