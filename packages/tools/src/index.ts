export { ToolRegistry, registry } from "./registry.js";
export type { ToolEntry, ToolSchema, ToolDefinition, ToolInfo } from "./types.js";
export {
  bindSessionSearch,
  type SessionSearchBindings,
  type SessionSearchFn,
  type SessionSearchHit,
  type ResolveRootFn,
} from "./builtins/session-search.js";
export {
  bindSkillView,
  type SkillViewBindings,
  type SkillViewEntry,
} from "./builtins/skill.js";
export {
  toolCallContext,
  getCurrentSessionId,
  type ToolCallContext,
} from "./session-context.js";

// Import builtins to trigger self-registration
import "./builtins/shell.js";
import "./builtins/file.js";
import "./builtins/session-search.js";
import "./builtins/edit.js";
import "./builtins/apply-patch.js";
import "./builtins/web-extract.js";
import "./builtins/web-search.js";
import "./builtins/execute_code.js";
import "./builtins/process.js";
import "./builtins/skill.js";
