#!/usr/bin/env node
import "@openacme/config/telemetry-bootstrap";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { resolveDataDir } from "@openacme/config";
import { setupCommand } from "./commands/setup.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { statusCommand } from "./commands/status.js";
import { logsCommand } from "./commands/logs.js";
import { serveInternalCommand } from "./commands/__serve.js";
import {
  secretShowCommand,
  secretRotateCommand,
} from "./commands/secret.js";
import { chatCommand } from "./commands/chat.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import {
  skillsListCommand,
  skillsViewCommand,
  skillsAddCommand,
  skillsRemoveCommand,
} from "./commands/skills.js";
import {
  mcpListCommand,
  mcpStatusCommand,
  mcpRemoveCommand,
  mcpTestCommand,
} from "./commands/mcp.js";
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
  .description("Start the OpenAcme daemon (idempotent; installs the service unit on first run)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("--no-browser", "Don't open browser automatically")
  .option(
    "--no-service",
    "Skip launchd/systemd unit; spawn detached with PID file (no auto-restart)"
  )
  .option("--expose", "Bind to 0.0.0.0, generate a secret, and start (enables remote access)")
  .action(async (opts) => {
    await showBanner(pkg.version);
    // Commander maps --no-service → opts.service=false and --no-browser →
    // opts.browser=false. Remap to the shape our command functions expect.
    await startCommand({
      dataDir: opts.dataDir,
      noBrowser: opts.browser === false,
      noService: opts.service === false,
      expose: opts.expose === true,
    });
  });

program
  .command("stop")
  .description("Stop the OpenAcme daemon (service unit stays installed)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("--no-service", "Operate against the no-service PID-file path")
  .action((opts) => stopCommand({
    dataDir: opts.dataDir,
    noService: opts.service === false,
  }));

program
  .command("restart")
  .description("Restart the OpenAcme daemon")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("--no-browser", "Don't open browser after restart")
  .option("--no-service", "Operate against the no-service PID-file path")
  .action((opts) => restartCommand({
    dataDir: opts.dataDir,
    noBrowser: opts.browser === false,
    noService: opts.service === false,
  }));

program
  .command("status")
  .description("Show daemon state, PID, bind, uptime, and recent log")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("--no-service", "Operate against the no-service PID-file path")
  .action((opts) => statusCommand({
    dataDir: opts.dataDir,
    noService: opts.service === false,
  }));

program
  .command("logs")
  .description("Print the daemon log (use -f to follow)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("-f, --follow", "Follow new lines as they arrive")
  .option("--tail <n>", "Lines to print initially (default: 200)")
  .action(logsCommand);

// Internal: the subcommand the service unit invokes to run the server in
// the foreground. Hidden from --help so users don't run it directly.
program
  .command("__serve", { hidden: true })
  .description("[internal] run the server foreground; invoked by launchd/systemd")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(serveInternalCommand);

const secret = program
  .command("secret")
  .description("Manage the access secret used for non-loopback web access");

secret
  .command("show", { isDefault: true })
  .description("Print the current secret")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(secretShowCommand);

secret
  .command("rotate")
  .description("Generate a new secret (invalidates existing sessions)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("--no-service", "Operate against the no-service PID-file path")
  .action(secretRotateCommand);

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

const skills = program
  .command("skills")
  .description("Manage skills (Anthropic Agent Skills format)");

skills
  .command("list")
  .description("List installed skills")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsListCommand);

skills
  .command("view <name>")
  .description("Print a skill's full body")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsViewCommand);

skills
  .command("add <path>")
  .description("Install a skill from a folder containing SKILL.md (or that file directly)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsAddCommand);

skills
  .command("remove <name>")
  .description("Delete an installed skill")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsRemoveCommand);

const mcp = program
  .command("mcp")
  .description("Manage MCP servers (Model Context Protocol)");

mcp
  .command("list")
  .description("List configured MCP servers from ~/.openacme/mcp.json")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(mcpListCommand);

mcp
  .command("status")
  .description("Live-test every MCP server and report status")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(mcpStatusCommand);

// `add` and `edit` go through hand-editing `~/.openacme/mcp.json` directly
// (or via the web UI's Settings → MCP → Edit JSON dialog). Same shape as
// Claude Desktop / Cursor / Cline, so configs paste in cleanly.
mcp
  .command("remove <name>")
  .description("Remove an MCP server from mcp.json")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(mcpRemoveCommand);

mcp
  .command("test <name>")
  .description("Dry-run a server's connection without registering its tools")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(mcpTestCommand);

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
