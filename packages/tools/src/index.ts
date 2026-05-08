export { ToolRegistry, registry } from "./registry.js";
export type { ToolEntry, ToolSchema, ToolDefinition, ToolInfo } from "./types.js";
export {
  bindSessionSearch,
  type SessionSearchFn,
  type SessionSearchHit,
} from "./builtins/session-search.js";

// Import builtins to trigger self-registration
import "./builtins/shell.js";
import "./builtins/file.js";
import "./builtins/session-search.js";
import "./builtins/edit.js";
import "./builtins/apply-patch.js";
import "./builtins/web-extract.js";
import "./builtins/web-search.js";
