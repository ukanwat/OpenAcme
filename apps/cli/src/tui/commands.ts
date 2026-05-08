import type { AgentManager } from "@openacme/server";
import type { Action } from "./state.js";

export interface CommandCtx {
  dispatch: (action: Action) => void;
  manager: AgentManager;
  agentId: string;
  exit: () => void;
}

export interface CommandDef {
  name: string;
  description: string;
  category: "session" | "agent" | "system" | "view";
  aliases?: string[];
  argsHint?: string;
  handler: (ctx: CommandCtx, args: string) => void | Promise<void>;
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
    name: "model",
    description: "Switch the agent's model",
    category: "agent",
    handler: (c) => c.dispatch({ type: "open-model-picker" }),
  },
  {
    name: "agent",
    description: "Switch the active agent",
    category: "agent",
    handler: (c) => c.dispatch({ type: "open-agent-picker" }),
  },
];

export function findCommand(input: string): CommandDef | undefined {
  const trimmed = input.trim().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase();
  if (!trimmed) return undefined;
  return COMMANDS.find(
    (c) => c.name === trimmed || c.aliases?.includes(trimmed)
  );
}

export function filterCommands(query: string): CommandDef[] {
  const q = query.replace(/^\//, "").toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter(
    (c) =>
      c.name.startsWith(q) ||
      c.aliases?.some((a) => a.startsWith(q))
  );
}
