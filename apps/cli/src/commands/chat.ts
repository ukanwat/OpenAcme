import * as p from "@clack/prompts";
import { loadConfig } from "@openacme/config";
import { AgentManager } from "@openacme/server";

/**
 * Interactive terminal chat.
 *
 * Routes to the Ink TUI when stdin/stdout are TTYs. Falls back to a plain
 * stream-to-stdout path for pipes (`echo "..." | openacme chat`) and CI.
 */
export async function chatCommand(opts: {
  agent?: string;
  dataDir?: string;
}): Promise<void> {
  const config = loadConfig(opts.dataDir);
  const manager = new AgentManager(config);
  await manager.initMCP();

  const agents = manager.listAgents();
  if (agents.length === 0) {
    p.cancel("No agents configured. Run `openacme setup` first.");
    await manager.close();
    process.exit(1);
  }

  const agentId = opts.agent ?? agents[0]!.id;
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    p.cancel(`Agent '${agentId}' not found.`);
    await manager.close();
    process.exit(1);
  }

  const interactive =
    process.stdout.isTTY === true && process.stdin.isTTY === true;

  try {
    if (!interactive) {
      const { runHeadless } = await import("../tui/headless.js");
      await runHeadless(manager, agent.id);
      return;
    }
    const { renderApp } = await import("../tui/render.js");
    await renderApp({ manager, agent, dataDir: config.dataDir });
  } finally {
    await manager.close();
  }
}
