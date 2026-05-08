import * as p from "@clack/prompts";
import {
  loadConfig,
  loadGlobalMcpServers,
  saveGlobalMcpServers,
  type MCPServerConfig,
} from "@openacme/config";
import { registry as toolRegistry } from "@openacme/tools";
import { MCPClient } from "@openacme/mcp-client";

export interface McpOptions {
  dataDir?: string;
}

function resolve(opts: McpOptions) {
  const config = loadConfig(opts.dataDir);
  const servers = loadGlobalMcpServers(config.dataDir);
  return { config, servers };
}

export async function mcpListCommand(opts: McpOptions): Promise<void> {
  const { config, servers } = resolve(opts);
  const entries = Object.entries(servers);
  const path = `${config.dataDir}/mcp.json`;
  if (entries.length === 0) {
    p.note(
      `No global MCP servers configured.\n\n` +
        `Edit ${path} to add servers — same JSON shape Claude Desktop, Cursor, ` +
        `and Cline use, so configs paste in cleanly. Or use Settings → MCP in ` +
        `the web UI.`,
      "MCP servers"
    );
    return;
  }
  const lines = entries.map(([name, cfg]) => {
    const target = cfg.command
      ? `${cfg.command}${cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : ""}`
      : (cfg.url ?? "");
    const transport = cfg.transport ?? (cfg.command ? "stdio" : "auto");
    const enabled = cfg.enabled === false ? "  (disabled)" : "";
    return `  ${name}  [${transport}]${enabled}\n    ${target}`;
  });
  p.note(
    lines.join("\n\n") + `\n\n  Edit ${path} to add or change servers.`,
    `MCP servers (${entries.length}) — ${path}`
  );
}

export async function mcpStatusCommand(opts: McpOptions): Promise<void> {
  const { servers } = resolve(opts);
  if (Object.keys(servers).length === 0) {
    p.note("No global MCP servers configured.", "MCP status");
    return;
  }

  // Live-test every enabled server in parallel — gives the operator the
  // same diagnostic the Settings UI shows, without needing the server up.
  const probe = new MCPClient(toolRegistry);
  const lines: string[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.enabled === false) {
      lines.push(`  ${name}  disabled`);
      continue;
    }
    const result = await probe.testConnection(cfg);
    if (result.ok) {
      lines.push(
        `  ${name}  ✓ connected via ${result.transport ?? "?"}  (${result.tools.length} tools)`
      );
    } else {
      lines.push(`  ${name}  ✗ ${result.error ?? "failed"}`);
    }
  }
  p.note(lines.join("\n"), "MCP status (live)");
}

export async function mcpRemoveCommand(
  name: string,
  opts: McpOptions
): Promise<void> {
  const { config, servers } = resolve(opts);
  if (!Object.prototype.hasOwnProperty.call(servers, name)) {
    p.cancel(`No server named '${name}' in ${config.dataDir}/mcp.json`);
    return;
  }
  const next: Record<string, MCPServerConfig> = { ...servers };
  delete next[name];
  saveGlobalMcpServers(config.dataDir, next);
  p.note(`Removed '${name}'.`, "MCP");
}

export async function mcpTestCommand(
  name: string,
  opts: McpOptions
): Promise<void> {
  const { servers } = resolve(opts);
  const cfg = servers[name];
  if (!cfg) {
    p.cancel(`No server named '${name}' in mcp.json`);
    return;
  }
  const probe = new MCPClient(toolRegistry);
  const result = await probe.testConnection(cfg);
  if (result.ok) {
    p.note(
      `Connected via ${result.transport ?? "?"} — ${result.tools.length} tools:\n  ` +
        result.tools.join("\n  "),
      `MCP test '${name}'`
    );
  } else {
    p.cancel(`Failed: ${result.error ?? "unknown"}`);
  }
}
