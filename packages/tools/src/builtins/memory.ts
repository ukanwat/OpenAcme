import { z } from "zod";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  MemoryStore,
  scanMemoryContent,
} from "@openacme/memory";
import { registry } from "../registry.js";
import { getCurrentAgentId } from "../session-context.js";

export interface MemoryBindings {
  /** Per-agent memory store, constructed by AgentManager against `<dataDir>/agents/`. */
  store: MemoryStore;
}

// Bound by AgentManager at construction time. Until then the tool returns
// a clear error rather than silently writing to a default path.
let bindings: MemoryBindings | null = null;

export function bindMemory(b: MemoryBindings): void {
  bindings = b;
}

/**
 * Verbatim port of Anthropic's auto-injected memory protocol from the
 * `memory_20250818` tool docs. Models trained on the canonical tool
 * recognize this exact wording — paraphrasing loses the trained behavior.
 */
const TOOL_DESCRIPTION = [
  "IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE.",
  "MEMORY PROTOCOL:",
  "1. Use the `view` command of your `memory` tool to check for earlier progress.",
  "2. ... (work on the task) ...",
  "     - As you make progress, record status / progress / thoughts etc in your memory.",
  "ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory.",
].join("\n");

/**
 * Single-object schema mirroring `memory_20250818`. Anthropic's tool API
 * requires `input_schema.type: "object"` at the root — Zod's discriminated
 * union compiles to a top-level `oneOf` with no `type`, which Anthropic
 * rejects. So the shape is one object with all command-specific fields
 * optional, plus a `superRefine` that enforces per-command requirements
 * at parse time. The model still sees the field-level descriptions and
 * the per-command requirements via the tool description below.
 */
const MemoryParams = z
  .object({
    command: z
      .enum([
        "view",
        "create",
        "str_replace",
        "insert",
        "delete",
        "rename",
      ])
      .describe("Memory operation to perform"),
    path: z
      .string()
      .optional()
      .describe(
        "Path under /memories. Required for view/create/str_replace/insert/delete."
      ),
    view_range: z
      .array(z.number().int())
      .length(2)
      .optional()
      .describe("view: optional [start, end] line range (1-indexed)"),
    file_text: z
      .string()
      .optional()
      .describe("create: full contents of the new file"),
    old_str: z
      .string()
      .optional()
      .describe(
        "str_replace: exact substring to replace; must appear verbatim and be unique"
      ),
    new_str: z
      .string()
      .optional()
      .describe("str_replace: replacement text"),
    insert_line: z
      .number()
      .int()
      .optional()
      .describe(
        "insert: line number to insert at (0-indexed: 0 = before first line, N = after last)"
      ),
    insert_text: z
      .string()
      .optional()
      .describe("insert: text to insert"),
    old_path: z
      .string()
      .optional()
      .describe("rename: existing path under /memories"),
    new_path: z
      .string()
      .optional()
      .describe("rename: new path under /memories (must not exist)"),
  })
  .superRefine((v, ctx) => {
    const need = (field: string) => {
      if (v[field as keyof typeof v] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for command=${v.command}`,
        });
      }
    };
    switch (v.command) {
      case "view":
      case "delete":
        need("path");
        break;
      case "create":
        need("path");
        need("file_text");
        break;
      case "str_replace":
        need("path");
        need("old_str");
        need("new_str");
        break;
      case "insert":
        need("path");
        need("insert_line");
        need("insert_text");
        break;
      case "rename":
        need("old_path");
        need("new_path");
        break;
    }
  });

type MemoryArgs = z.infer<typeof MemoryParams>;

registry.register({
  name: "memory",
  toolset: "memory",
  description: TOOL_DESCRIPTION,
  parameters: MemoryParams,
  emoji: "🧠",
  parallelSafe: false,
  handler: async (args) => {
    const params = args as MemoryArgs;

    if (!bindings) {
      return JSON.stringify({
        error: "memory not initialized — AgentManager must call bindMemory().",
      });
    }

    const agentId = getCurrentAgentId();
    if (!agentId) {
      return JSON.stringify({
        error: "memory tool requires an active agent context.",
      });
    }

    const charLimit = DEFAULT_MEMORY_CHAR_LIMIT;
    const { store } = bindings;

    // After superRefine, the per-command required fields are guaranteed
    // present — the `!` assertions below can't trip at runtime because
    // Zod would have rejected the call upstream.
    switch (params.command) {
      case "view": {
        const range = params.view_range
          ? ([params.view_range[0]!, params.view_range[1]!] as const)
          : undefined;
        return store.view(agentId, params.path!, range);
      }

      case "create": {
        const scan = scanMemoryContent(params.file_text!);
        if (!scan.ok) return scan.reason;
        return await store.create(
          agentId,
          params.path!,
          params.file_text!,
          charLimit
        );
      }

      case "str_replace": {
        const scan = scanMemoryContent(params.new_str!);
        if (!scan.ok) return scan.reason;
        return await store.strReplace(
          agentId,
          params.path!,
          params.old_str!,
          params.new_str!,
          charLimit
        );
      }

      case "insert": {
        const scan = scanMemoryContent(params.insert_text!);
        if (!scan.ok) return scan.reason;
        return await store.insert(
          agentId,
          params.path!,
          params.insert_line!,
          params.insert_text!,
          charLimit
        );
      }

      case "delete": {
        return await store.delete(agentId, params.path!);
      }

      case "rename": {
        return await store.rename(agentId, params.old_path!, params.new_path!);
      }
    }
  },
});
