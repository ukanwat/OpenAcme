export { ToolRegistry, registry } from "./registry.js";
export type { ToolEntry, ToolSchema, ToolDefinition } from "./types.js";

// Import builtins to trigger self-registration
import "./builtins/shell.js";
import "./builtins/file.js";
