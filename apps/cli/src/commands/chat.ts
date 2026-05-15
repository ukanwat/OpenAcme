import * as p from "@clack/prompts";
import { loadConfig } from "@openacme/config";
import { AgentManager } from "@openacme/server";
import { sanitizeStoredHistory, type UIMessage } from "@openacme/agent-core";
import { dbMessagesToTuiMessages } from "../tui/restore.js";

/**
 * Interactive terminal chat.
 *
 * Routes to the Ink TUI when stdin/stdout are TTYs. Falls back to a plain
 * stream-to-stdout path for pipes (`echo "..." | openacme chat`) and CI.
 *
 * TUI landing follows the same IA as the web home page: the sessions
 * list is the default; chat is a sub-view entered by picking a row or
 * starting a new chat. Explicit `--agent` or `--session` flags bypass
 * the list and jump straight to chat (preserves the scripting path).
 */
export async function chatCommand(opts: {
  agent?: string;
  session?: string;
  dataDir?: string;
}): Promise<void> {
  const config = loadConfig(opts.dataDir);
  // In interactive TUI mode, Ink owns the terminal — pino's default stderr
  // sink would corrupt the rendered UI. Route logs to a side file in the
  // data dir before any agent code runs (the logger reads this env on
  // first write). Headless mode is fine on stderr.
  if (
    !process.env["OPENACME_LOG_FILE"] &&
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true
  ) {
    process.env["OPENACME_LOG_FILE"] = `${config.dataDir}/openacme-tui.log`;
  }
  const manager = new AgentManager(config);
  await manager.initMCP();
  // Materialize the default Acme agent on a fresh install so terminal
  // chat works without `openacme setup` having been run first.
  await manager.ensureDefaultAgents();
  // Start the scheduler so autonomous turns + heartbeat probes run
  // while the operator is in a terminal chat — same workforce behavior
  // as the web daemon. Without this, recurring tasks and ping_user
  // events never fire from the CLI.
  await manager.taskScheduler.start();

  const agents = manager.listAgents();
  if (agents.length === 0) {
    // ensureDefaultAgents above tries to import Acme on a fresh install.
    // If we still have zero agents the catalog failed to materialize —
    // surface the daemon log path so the user can see why.
    p.cancel(
      "No agents available. The default Acme agent failed to materialize — check the daemon log (`openacme logs`) for details, or run `openacme setup` to configure a provider."
    );
    await manager.close();
    process.exit(1);
  }

  const interactive =
    process.stdout.isTTY === true && process.stdin.isTTY === true;

  // Decision tree — see CLAUDE.md "TUI landing" / plan piece A.4.
  let initialView: "sessions" | "chat" = "sessions";
  let initialAgentId: string = agents[0]!.id;
  let initialSessionId: string | undefined;
  let initialCommitted: UIMessage[] | undefined;

  if (opts.session) {
    const sess = manager.sessionStore.get(opts.session);
    if (!sess) {
      p.cancel(`Session '${opts.session}' not found.`);
      await manager.close();
      process.exit(1);
    }
    const owner = agents.find((a) => a.id === sess.agentId);
    if (!owner) {
      p.cancel(
        `Session '${opts.session}' belongs to deleted agent '${sess.agentId}'.`
      );
      await manager.close();
      process.exit(1);
    }
    if (opts.agent && opts.agent !== sess.agentId) {
      console.warn(
        `--agent ${opts.agent} ignored: session ${opts.session} belongs to ${sess.agentId}`
      );
    }
    initialView = "chat";
    initialAgentId = owner.id;
    initialSessionId = opts.session;
    initialCommitted = dbMessagesToTuiMessages(
      sanitizeStoredHistory(manager.messageStore.getHistory(opts.session))
    );
  } else if (opts.agent) {
    const explicit = agents.find((a) => a.id === opts.agent);
    if (!explicit) {
      p.cancel(`Agent '${opts.agent}' not found.`);
      await manager.close();
      process.exit(1);
    }
    initialView = "chat";
    initialAgentId = explicit.id;
  }

  const agent = agents.find((a) => a.id === initialAgentId);
  if (!agent) {
    p.cancel(`Agent '${initialAgentId}' not found.`);
    await manager.close();
    process.exit(1);
  }

  try {
    if (!interactive) {
      const { runHeadless } = await import("../tui/headless.js");
      // Headless ignores --session for now (sessions-list IA doesn't
      // apply to one-shot pipe runs). Stay on --agent only.
      await runHeadless(manager, agent.id);
      return;
    }
    const { renderApp } = await import("../tui/render.js");
    await renderApp({
      manager,
      agent,
      dataDir: config.dataDir,
      initialView,
      initialSessionId,
      initialCommitted,
    });
  } finally {
    await manager.close();
  }
}
