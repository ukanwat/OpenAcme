import { z } from 'zod';
import * as fs from "node:fs";
import * as path from "node:path";
import { registry } from "../registry.js";

/**
 * File tools — read, write, list, search files.
 * Mirrors Hermes tools/file_tools.py.
 */

const MAX_LINES_LIMIT = 10000;
const MAX_DEPTH_LIMIT = 10;
const MAX_SEARCH_RESULTS = 500;

// ── read_file ──
registry.register({
  name: "read_file",
  toolset: "filesystem",
  description: "Read the contents of a file at the given path.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative path to the file"),
    maxLines: z.number().min(1).max(MAX_LINES_LIMIT).optional().describe("Maximum number of lines to read (max 10000)"),
  }),
  emoji: "📄",
  parallelSafe: true,
  handler: async (args) => {
    const { path: filePath, maxLines } = args as {
      path: string;
      maxLines?: number;
    };
    try {
      const resolved = path.resolve(filePath);
      const content = fs.readFileSync(resolved, "utf-8");
      if (maxLines) {
        const lines = content.split("\n").slice(0, maxLines).join("\n");
        return JSON.stringify({
          success: true,
          path: resolved,
          content: lines,
          truncated: content.split("\n").length > maxLines,
        });
      }
      return JSON.stringify({ success: true, path: resolved, content });
    } catch (error: unknown) {
      return JSON.stringify({
        error: (error as Error).message,
        path: filePath,
      });
    }
  },
});

// ── write_file ──
registry.register({
  name: "write_file",
  toolset: "filesystem",
  description:
    "Write content to a file. Creates the file and any parent directories if they don't exist.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative path for the file"),
    content: z.string().describe("Content to write to the file"),
  }),
  emoji: "✍️",
  parallelSafe: false,
  handler: async (args) => {
    const { path: filePath, content } = args as {
      path: string;
      content: string;
    };
    try {
      const resolved = path.resolve(filePath);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolved, content, "utf-8");
      return JSON.stringify({
        success: true,
        path: resolved,
        bytesWritten: Buffer.byteLength(content),
      });
    } catch (error: unknown) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
});

// ── list_files ──
registry.register({
  name: "list_files",
  toolset: "filesystem",
  description:
    "List files and directories at the given path. Returns names, types, and sizes.",
  parameters: z.object({
    path: z
      .string()
      .optional()
      .default(".")
      .describe("Directory path to list (default: current directory)"),
    recursive: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, list recursively"),
    maxDepth: z.number().min(1).max(MAX_DEPTH_LIMIT).optional().default(3).describe("Max recursion depth (max 10)"),
  }),
  emoji: "📁",
  parallelSafe: true,
  handler: async (args) => {
    const {
      path: dirPath,
      recursive,
      maxDepth,
    } = args as {
      path: string;
      recursive: boolean;
      maxDepth: number;
    };

    function listDir(
      dir: string,
      depth: number
    ): Array<{ name: string; type: string; size?: number }> {
      const entries: Array<{ name: string; type: string; size?: number }> = [];
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (item.name.startsWith(".")) continue; // skip hidden
          const fullPath = path.join(dir, item.name);
          if (item.isDirectory()) {
            entries.push({ name: item.name + "/", type: "directory" });
            if (recursive && depth < maxDepth) {
              const children = listDir(fullPath, depth + 1);
              for (const child of children) {
                entries.push({
                  ...child,
                  name: item.name + "/" + child.name,
                });
              }
            }
          } else {
            const stat = fs.statSync(fullPath);
            entries.push({
              name: item.name,
              type: "file",
              size: stat.size,
            });
          }
        }
      } catch (error: unknown) {
        entries.push({
          name: `[error: ${(error as Error).message}]`,
          type: "error",
        });
      }
      return entries;
    }

    const resolved = path.resolve(dirPath);
    const entries = listDir(resolved, 0);
    return JSON.stringify({
      success: true,
      path: resolved,
      entries,
      count: entries.length,
    });
  },
});

// ── search_files ──
registry.register({
  name: "search_files",
  toolset: "filesystem",
  description:
    "Search for a text pattern across files using grep. Returns matching lines with file paths and line numbers.",
  parameters: z.object({
    pattern: z.string().describe("Text pattern or regex to search for"),
    path: z
      .string()
      .optional()
      .default(".")
      .describe("Directory to search in (default: current directory)"),
    fileGlob: z
      .string()
      .optional()
      .describe("File glob pattern to filter (e.g. '*.ts')"),
    maxResults: z.number().min(1).max(MAX_SEARCH_RESULTS).optional().default(50).describe("Max results (max 500)"),
  }),
  emoji: "🔍",
  parallelSafe: true,
  handler: async (args) => {
    const { pattern, path: searchPath, fileGlob, maxResults } = args as {
      pattern: string;
      path: string;
      fileGlob?: string;
      maxResults: number;
    };

    try {
      const { execSync } = await import("node:child_process");
      const resolved = path.resolve(searchPath);

      // Escape shell special characters in user input
      const escapeShellArg = (arg: string): string =>
        arg.replace(/[\\"`$]/g, "\\$&");

      let cmd = `grep -rnI --max-count=${maxResults}`;
      if (fileGlob) {
        // Validate fileGlob doesn't contain shell injection characters
        if (/[;&|`$(){}]/.test(fileGlob)) {
          return JSON.stringify({
            error: "Invalid fileGlob: contains disallowed characters",
            pattern,
          });
        }
        cmd += ` --include="${escapeShellArg(fileGlob)}"`;
      }
      cmd += ` "${escapeShellArg(pattern)}" "${escapeShellArg(resolved)}"`;

      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }).trim();

      const matches = output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(.+?):(\d+):(.*)$/);
          if (match) {
            return {
              file: match[1],
              line: parseInt(match[2]!, 10),
              content: match[3]!.trim(),
            };
          }
          return { file: "", line: 0, content: line };
        });

      return JSON.stringify({
        success: true,
        pattern,
        matches,
        count: matches.length,
      });
    } catch {
      return JSON.stringify({
        success: true,
        pattern,
        matches: [],
        count: 0,
        note: "No matches found",
      });
    }
  },
});
