import type { AgentManager } from "@openacme/server";
import type { Action } from "./state.js";

export interface CommandCtx {
  dispatch: (action: Action) => void;
  manager: AgentManager;
  agentId: string;
  exit: () => void;
  /** Submit a user message turn (post-expansion). Used by skill commands
   *  to send the inlined SKILL.md body as the next turn's user text. */
  sendTurn: (text: string) => void;
}

export interface CommandDef {
  name: string;
  description: string;
  category: "session" | "agent" | "system" | "view" | "skill";
  aliases?: string[];
  argsHint?: string;
  handler: (ctx: CommandCtx, args: string) => void | Promise<void>;
}

/** Dynamic skill commands — built per chat session from the manager's
 *  skill registry. Each skill becomes a `/<skill-name>` command whose
 *  handler inlines the SKILL.md body into the next user turn so the
 *  agent has no choice but to apply it. Optional trailing text after
 *  the command name becomes the user's actual ask appended below the
 *  skill body. */
export function buildSkillCommands(manager: AgentManager): CommandDef[] {
  return manager.skillRegistry.getIndex().map((entry) => ({
    name: entry.name,
    description: entry.description,
    category: "skill" as const,
    handler: (c, args) => {
      const skill = c.manager.skillRegistry.getSkill(entry.name);
      if (!skill) {
        c.dispatch({
          type: "stream-error",
          error: `Skill '${entry.name}' not found in registry`,
        });
        return;
      }
      const rest = args.trim();
      const text =
        `[Skill: ${entry.name}]\n\n${skill.body}\n\n---\n\n` +
        (rest || "Apply this skill.");
      c.sendTurn(text);
    },
  }));
}

export const COMMANDS: CommandDef[] = [
  {
    name: "new",
    description: "Start a new session",
    category: "session",
    handler: (c) => c.dispatch({ type: "new-session" }),
  },
  {
    name: "clear",
    description: "Clear the screen",
    category: "view",
    handler: (c) => c.dispatch({ type: "clear" }),
  },
  {
    name: "help",
    description: "Show available commands",
    category: "system",
    handler: (c) => c.dispatch({ type: "show-help" }),
  },
  {
    name: "exit",
    description: "Exit the chat",
    category: "system",
    aliases: ["quit"],
    handler: (c) => c.exit(),
  },
  {
    name: "models",
    description: "Switch the agent's model",
    category: "agent",
    handler: (c) => c.dispatch({ type: "open-model-picker" }),
  },
  {
    name: "agents",
    description: "Switch the active agent",
    category: "agent",
    handler: (c) => c.dispatch({ type: "open-agent-picker" }),
  },
  {
    name: "sessions",
    description: "Back to the sessions list",
    category: "session",
    handler: (c) => c.dispatch({ type: "enter-sessions" }),
  },
  {
    name: "skills",
    description: "Show skills available to this agent",
    category: "agent",
    handler: (c) => c.dispatch({ type: "open-skills-overlay" }),
  },
  {
    name: "mcp",
    description: "Show MCP servers + status for this agent",
    category: "agent",
    handler: (c) => c.dispatch({ type: "open-mcp-overlay" }),
  },
  {
    name: "tasks",
    description: "List your tasks for the current agent",
    category: "view",
    handler: (c) => c.dispatch({ type: "open-tasks-overlay" }),
  },
];

export function findCommand(
  input: string,
  extra: CommandDef[] = []
): CommandDef | undefined {
  const trimmed = input.trim().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase();
  if (!trimmed) return undefined;
  const all = [...COMMANDS, ...extra];
  return all.find((c) => c.name === trimmed || c.aliases?.includes(trimmed));
}

export function filterCommands(
  query: string,
  extra: CommandDef[] = []
): CommandDef[] {
  const all = [...COMMANDS, ...extra];
  const q = query.replace(/^\//, "").toLowerCase();
  if (!q) return all;
  return all.filter(
    (c) =>
      c.name.startsWith(q) ||
      c.aliases?.some((a) => a.startsWith(q))
  );
}
