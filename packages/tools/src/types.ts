import { z } from 'zod';

/**
 * Schema for a tool's parameter definition (maps to JSON Schema).
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: z.ZodType;
}

/**
 * A registered tool entry — mirrors Hermes tools/registry.py ToolEntry.
 */
export interface ToolEntry {
  /** Unique tool name (e.g. "shell", "read_file", "mcp-github__create_issue") */
  name: string;
  /** Group name (e.g. "terminal", "filesystem", "mcp-github") */
  toolset: string;
  /** Tool description for the LLM */
  description: string;
  /** Zod schema for parameters */
  parameters: z.ZodType;
  /** Handler function — takes parsed args, returns result string */
  handler: (args: Record<string, unknown>) => Promise<string>;
  /** Optional: check if tool is available (e.g. Docker installed) */
  checkFn?: () => boolean;
  /** Emoji for display */
  emoji?: string;
  /** Whether this tool is safe to run in parallel with other tools */
  parallelSafe?: boolean;
  /** Max result size in characters */
  maxResultSizeChars?: number;
}

/**
 * OpenAI-format tool definition for the LLM API.
 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Serializable tool description suitable for sending to UI clients.
 * Mirrors the subset of {@link ToolEntry} fields that are safe to expose.
 */
export interface ToolInfo {
  name: string;
  description: string;
  toolset: string;
  emoji?: string;
}
