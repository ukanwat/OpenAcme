import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { MCPServerConfigSchema, type MCPServerConfig } from "./schema.js";

const FILE_NAME = "mcp.json";

/**
 * `~/.openacme/mcp.json` — the catalog of MCP servers shared across
 * every agent. Same `{ "mcpServers": {...} }` shape that Claude Desktop,
 * Claude Code, Cursor, Cline, and Windsurf use, so users can paste
 * configs from any of them.
 *
 * Per-agent `mcpServers` (in AGENT.md) is reserved for agent-PRIVATE
 * servers. Names must not collide with the global catalog — the
 * agent-store enforces this on write.
 *
 * Tokens for OAuth-bound servers do NOT live here; they live at
 * `<dataDir>/mcp-tokens/<server>.json` (mode 0600). This file is
 * round-tripped through user-edited paths (UI, hand-edits) and would
 * shuffle credentials around on every save.
 */
const McpJsonSchema = z.object({
  mcpServers: z.record(MCPServerConfigSchema).default({}),
});

function mcpPath(dataDir: string): string {
  return path.join(dataDir, FILE_NAME);
}

/**
 * Read the global MCP catalog. Returns `{}` if the file is absent or
 * malformed — a missing/broken catalog should not block boot.
 */
export function loadGlobalMcpServers(
  dataDir: string
): Record<string, MCPServerConfig> {
  const p = mcpPath(dataDir);
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
    return McpJsonSchema.parse(raw).mcpServers;
  } catch (e) {
    console.warn(
      `Failed to parse ${FILE_NAME}: ${e instanceof Error ? e.message : String(e)}. Treating as empty.`
    );
    return {};
  }
}

/**
 * Atomic write — tempfile in same dir, then rename. Prevents readers
 * from observing a half-written file when the editor saves.
 */
export function saveGlobalMcpServers(
  dataDir: string,
  servers: Record<string, MCPServerConfig>
): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const target = mcpPath(dataDir);
  const tmp = target + ".tmp." + process.pid;
  const body = JSON.stringify({ mcpServers: servers }, null, 2);
  fs.writeFileSync(tmp, body, "utf-8");
  fs.renameSync(tmp, target);
}

export { McpJsonSchema };
