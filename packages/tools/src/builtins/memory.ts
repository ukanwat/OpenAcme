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
 * The MEMORY.md index is already in the system prompt (`buildMemorySection`
 * in agent-core) and a full convention section ships alongside it. This
 * description is therefore opt-in: when to view, when to write — not the
 * eager "ALWAYS VIEW FIRST" preamble from Anthropic's memory_20250818 docs.
 * That preamble suits headless agents whose context can reset arbitrarily;
 * with the index already attached and a chat user present, it just adds
 * a tool round-trip and a "I'll check my memory" preface to every first turn.
 */
const TOOL_DESCRIPTION = [
  "Read and write entries in your persistent memory.",
  "Paths are bare relative names: `MEMORY.md`, `notes.md`, `peers/coder.md`. They match the link targets shown in your MEMORY.md index verbatim. No leading slash. No `/memories/` prefix.",
  "Your MEMORY.md index is already in your system prompt; call `view` on a specific entry file when it looks relevant to the work, when the user references prior conversations, or when you're explicitly asked to recall. Pass an empty path to view to list everything.",
  "Use `create` / `str_replace` / `insert` / `delete` / `rename` to maintain memory entries — see the memory convention in your system prompt for the file shape and what NOT to save.",
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
        "Bare relative path: `MEMORY.md`, `notes.md`, `peers/coder.md`. No leading slash. Required for view/create/str_replace/insert/delete. Empty string on `view` lists the memory dir."
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
      .describe("rename: existing bare relative path"),
    new_path: z
      .string()
      .optional()
      .describe("rename: new bare relative path (must not exist)"),
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
