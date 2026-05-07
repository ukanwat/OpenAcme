import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolEntry, ToolDefinition } from "./types.js";

/**
 * Singleton tool registry — mirrors Hermes tools/registry.py ToolRegistry.
 *
 * Tools self-register via `registry.register()`. MCP tools are dynamically
 * added/removed. The registry provides definitions for the LLM API and
 * dispatches tool calls to their handlers.
 */
export class ToolRegistry {
  private _tools = new Map<string, ToolEntry>();
  private _generation = 0;

  /**
   * Register a tool. Called at initialization time or dynamically for MCP tools.
   */
  register(entry: ToolEntry): void {
    const existing = this._tools.get(entry.name);
    if (existing && existing.toolset !== entry.toolset) {
      // Prevent shadowing unless both are MCP tools (legitimate: server refresh)
      const bothMcp =
        existing.toolset.startsWith("mcp-") && entry.toolset.startsWith("mcp-");
      if (!bothMcp) {
        console.error(
          `Tool registration REJECTED: '${entry.name}' (toolset '${entry.toolset}') would shadow existing tool from toolset '${existing.toolset}'`
        );
        return;
      }
    }
    this._tools.set(entry.name, entry);
    this._generation++;
  }

  /**
   * Remove a tool from the registry. Used by MCP dynamic tool discovery.
   */
  deregister(name: string): void {
    if (this._tools.delete(name)) {
      this._generation++;
    }
  }

  /**
   * Get a tool entry by name.
   */
  get(name: string): ToolEntry | undefined {
    return this._tools.get(name);
  }

  /**
   * Get all registered tool names.
   */
  getAllToolNames(): string[] {
    return [...this._tools.keys()].sort();
  }

  /**
   * Get tool definitions in the format expected by the Vercel AI SDK.
   * Only includes tools whose checkFn() passes (or have no checkFn).
   */
  getDefinitions(toolNames?: Set<string>): ToolDefinition[] {
    const result: ToolDefinition[] = [];
    for (const entry of this._tools.values()) {
      if (toolNames && !toolNames.has(entry.name)) continue;
      if (entry.checkFn && !entry.checkFn()) continue;

      result.push({
        type: "function",
        function: {
          name: entry.name,
          description: entry.description,
          parameters: zodToJsonSchema(entry.parameters, { target: "openAi" }),
        },
      });
    }
    return result;
  }

  /**
   * Get tools as a Vercel AI SDK `tools` object for generateText/streamText.
   */
  getVercelTools(toolNames?: Set<string>): Record<string, unknown> {
    const tools: Record<string, unknown> = {};
    for (const entry of this._tools.values()) {
      if (toolNames && !toolNames.has(entry.name)) continue;
      if (entry.checkFn && !entry.checkFn()) continue;

      tools[entry.name] = {
        description: entry.description,
        parameters: entry.parameters,
        execute: async (args: Record<string, unknown>) => {
          return entry.handler(args);
        },
      };
    }
    return tools;
  }

  /**
   * Dispatch a tool call by name.
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const entry = this._tools.get(name);
    if (!entry) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    try {
      return await entry.handler(args);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: `Tool execution failed: ${message}` });
    }
  }

  /**
   * Current generation counter. Consumers can cache against this.
   */
  get generation(): number {
    return this._generation;
  }

  /**
   * Get unique toolset names.
   */
  getToolsets(): string[] {
    const sets = new Set<string>();
    for (const entry of this._tools.values()) {
      sets.add(entry.toolset);
    }
    return [...sets].sort();
  }
}

/** Module-level singleton */
export const registry = new ToolRegistry();
