#!/usr/bin/env node
import { Command } from "commander";
import figlet from "figlet";
import gradient from "gradient-string";
import { setupCommand } from "./commands/setup.js";
import { startCommand } from "./commands/start.js";
import { chatCommand } from "./commands/chat.js";

const coolGradient = gradient(["#0ea5e9", "#7dd3fc", "#ffffff"]);

// Show banner
function showBanner() {
  const banner = figlet.textSync("OpenAcme", { font: "Slant" });
  console.log(coolGradient(banner));
}

const program = new Command();

program
  .name("openacme")
  .description("OpenAcme — AI agent platform with multi-LLM support")
  .version("0.0.1");

// Default action: start the server (when no command given)
program
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("-p, --port <number>", "Server port", "3210")
  .option("--no-browser", "Don't open browser automatically")
  .action(async (opts) => {
    // If no subcommand, start the server
    showBanner();
    await startCommand(opts);
  });

program
  .command("setup")
  .description("Interactive setup wizard — configure API keys and create first agent")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(setupCommand);

program
  .command("start")
  .description("Start the OpenAcme agent server")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("-p, --port <number>", "Server port", "3210")
  .option("--no-browser", "Don't open browser automatically")
  .action(async (opts) => {
    showBanner();
    await startCommand(opts);
  });

program
  .command("chat")
  .description("Start a terminal chat session with an agent")
  .option("-a, --agent <id>", "Agent ID to chat with (default: first agent)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(chatCommand);

program.parse();
