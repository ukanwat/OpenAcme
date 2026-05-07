import { z } from "zod";
import { execSync } from "node:child_process";
import { registry } from "../registry.js";

const DESTRUCTIVE_PATTERNS = /(?:^|\s|&&|\|\||;|`)(?:rm\s|rmdir\s|cp\s|mv\s|sed\s+-i|truncate\s|dd\s|shred\s|git\s+(?:reset|clean|checkout)\s)/;

/**
 * Shell tool — execute terminal commands.
 * Mirrors Hermes tools/terminal_tool.py with safety checks.
 */
registry.register({
  name: "shell",
  toolset: "terminal",
  description:
    "Execute a shell command and return its output. Use for running scripts, " +
    "installing packages, checking system state, and any terminal operations.",
  parameters: z.object({
    command: z.string().describe("The shell command to execute"),
    timeout: z
      .number()
      .optional()
      .default(30000)
      .describe("Timeout in milliseconds (default: 30000)"),
  }),
  emoji: "🖥️",
  parallelSafe: false,
  maxResultSizeChars: 50_000,

  handler: async (args) => {
    const { command, timeout } = args as { command: string; timeout: number };

    if (!command.trim()) {
      return JSON.stringify({ error: "Empty command" });
    }

    // Flag destructive commands (user can still run them)
    const isDestructive = DESTRUCTIVE_PATTERNS.test(command);

    try {
      const output = execSync(command, {
        timeout,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024 * 10, // 10MB
        shell: "/bin/bash",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const result = {
        success: true,
        output: output.trim(),
        command,
        ...(isDestructive && { warning: "This was a destructive command" }),
      };

      // Truncate if too long
      const json = JSON.stringify(result);
      if (json.length > 50_000) {
        result.output =
          result.output.slice(0, 49_000) +
          "\n... [output truncated]";
        return JSON.stringify(result);
      }
      return json;
    } catch (error: unknown) {
      const err = error as {
        status?: number;
        stderr?: string;
        stdout?: string;
        message?: string;
      };
      return JSON.stringify({
        success: false,
        error: err.stderr?.trim() || err.message || "Command failed",
        exitCode: err.status ?? 1,
        stdout: err.stdout?.trim() || "",
        command,
      });
    }
  },
});
