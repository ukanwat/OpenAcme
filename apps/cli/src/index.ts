#!/usr/bin/env node
import "@openacme/config/telemetry-bootstrap";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { resolveDataDir } from "@openacme/config";
import { setupCommand } from "./commands/setup.js";
import { startCommand } from "./commands/start.js";
import { chatCommand } from "./commands/chat.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { showBanner } from "./tui/banner.js";

const pkg = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
) as { version: string };

const program = new Command();

program
  .name("openacme")
  .description("OpenAcme — AI agent platform with multi-LLM support")
  .version(pkg.version);

// `start` is the default — running `openacme` with no subcommand dispatches
// here. Defining options on the program level AND the subcommand caused
// Commander to consume them at the program level and the subcommand action
// would receive opts without dataDir/port/noBrowser.
program
  .command("start", { isDefault: true })
  .description("Start the OpenAcme agent server")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("-p, --port <number>", "Server port", "3210")
  .option("--no-browser", "Don't open browser automatically")
  .action(async (opts) => {
    await showBanner(pkg.version);
    await startCommand(opts);
  });

program
  .command("setup")
  .description("Interactive setup wizard — configure API keys and create first agent")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(setupCommand);

program
  .command("chat")
  .description("Start a terminal chat session with an agent")
  .option("-a, --agent <id>", "Agent ID to chat with (default: first agent)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(chatCommand);

program
  .command("login")
  .description("Sign in with ChatGPT or Claude (use your subscription instead of API credits)")
  .option("-p, --provider <name>", "openai or anthropic")
  .option("--device", "Use device-code flow (works on SSH/headless)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(loginCommand);

program
  .command("logout")
  .description("Sign out — remove stored OAuth tokens")
  .option("-p, --provider <name>", "openai or anthropic")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(logoutCommand);

// Resolve the data dir once so the LLM provider's OAuth path can find auth.json
// without us threading the path through every call site.
const initialDataDir = resolveDataDir(
  process.argv.includes("--data-dir")
    ? process.argv[process.argv.indexOf("--data-dir") + 1]
    : process.argv.includes("-d")
      ? process.argv[process.argv.indexOf("-d") + 1]
      : undefined,
);
process.env["OPENACME_DATA_DIR"] = initialDataDir;

program.parse();
