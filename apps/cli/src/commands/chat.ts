import * as p from "@clack/prompts";
import chalk from "chalk";
import figlet from "figlet";
import gradient from "gradient-string";
import * as readline from "node:readline";
import { loadConfig } from "@openacme/config";
import { AgentManager } from "@openacme/server";

/**
 * Display welcome banner for chat session.
 */
function showBanner() {
  const coolGradient = gradient(["#0ea5e9", "#7dd3fc", "#ffffff"]);
  const banner = figlet.textSync("OpenAcme", { font: "Slant" });
  console.log(coolGradient(banner));
  console.log(coolGradient("  AI Agent Platform\n"));
}

/**
 * Interactive terminal chat with an agent.
 * Consumes SSE chunks from the agent and renders them in the terminal.
 */
export async function chatCommand(opts: { agent?: string; dataDir?: string }) {
  showBanner();

  const config = loadConfig(opts.dataDir);
  const manager = new AgentManager(config);

  // Initialize MCP connections
  await manager.initMCP();

  const agents = manager.listAgents();
  if (agents.length === 0) {
    p.cancel("No agents configured. Run `openacme setup` first.");
    process.exit(1);
  }

  const agentId = opts.agent ?? agents[0]!.id;
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    p.cancel(`Agent '${agentId}' not found.`);
    process.exit(1);
  }

  // Show agent info
  p.note(
    `Agent: ${agent.name}\nModel: ${agent.model.provider}/${agent.model.model}`,
    "Session Info"
  );

  console.log(chalk.dim('  Type "exit" or press Ctrl+C to quit.\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Handle Ctrl+C gracefully
  rl.on("close", () => {
    console.log(chalk.dim("\n\nGoodbye!\n"));
    manager.close();
    process.exit(0);
  });

  let sessionId: string | undefined;

  const prompt = () => {
    rl.question(chalk.bold.green("you > "), async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit" || trimmed === "quit") {
        console.log(chalk.dim("\nGoodbye!\n"));
        manager.close();
        rl.close();
        return;
      }

      process.stdout.write(chalk.bold.blue("\nassistant > "));

      try {
        for await (const chunk of manager.chat(
          agentId,
          sessionId ?? "cli-session",
          trimmed
        )) {
          switch (chunk.type) {
            case "text-delta":
              process.stdout.write(chunk.text);
              break;
            case "tool-call":
              process.stdout.write(
                chalk.cyan(`\n  [tool] ${chunk.toolName}`) +
                  chalk.dim(`(${JSON.stringify(chunk.args).slice(0, 80)}...)`)
              );
              break;
            case "tool-result":
              process.stdout.write(
                chalk.green(`\n  [result] `) +
                  chalk.dim(chunk.result.slice(0, 150) + (chunk.result.length > 150 ? "..." : ""))
              );
              break;
            case "error":
              process.stdout.write(chalk.red(`\n  [error] ${chunk.error}`));
              break;
            case "done":
              if (chunk.usage) {
                process.stdout.write(
                  chalk.dim(`\n  [tokens: ${chunk.usage.totalTokens}]`)
                );
              }
              break;
          }
        }
      } catch (error) {
        console.error(
          chalk.red(`\n  Error: ${error instanceof Error ? error.message : String(error)}`)
        );
      }

      process.stdout.write("\n\n");
      if (!sessionId) sessionId = "cli-session";
      prompt();
    });
  };

  prompt();
}
