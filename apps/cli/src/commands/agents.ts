import * as p from "@clack/prompts";
import { loadConfig } from "@openacme/config";
import { AgentManager } from "@openacme/server";

export interface AgentsOptions {
  dataDir?: string;
}

export interface AgentsImportOptions extends AgentsOptions {
  id?: string;
  name?: string;
}

export async function agentsCatalogCommand(
  opts: AgentsOptions
): Promise<void> {
  const config = loadConfig(opts.dataDir);
  const manager = new AgentManager(config);
  try {
    const templates = manager.agentCatalog.list();
    if (templates.length === 0) {
      p.note("No bundled templates available.", "Agent catalog");
      return;
    }
    const lines = templates.map((t) => {
      const tags = t.tags.length > 0 ? `  [${t.tags.join(", ")}]` : "";
      const counts = `${t.counts.resources} files · ${t.counts.skills} skills · ${t.counts.mcpServers} MCPs`;
      return `  ${t.id}${tags}\n    ${t.name} — ${t.description}\n    ${counts}`;
    });
    p.note(lines.join("\n\n"), `Agent catalog (${templates.length})`);
    p.log.message(
      `Import one with:  openacme agents import <id> [--name <Display Name>] [--id <agent-id>]`
    );
  } finally {
    await manager.close();
  }
}

export async function agentsImportCommand(
  templateId: string,
  opts: AgentsImportOptions
): Promise<void> {
  const config = loadConfig(opts.dataDir);
  const manager = new AgentManager(config);
  try {
    const result = await manager.importAgentFromTemplate(templateId, {
      idOverride: opts.id,
      nameOverride: opts.name,
    });
    const { agent, manifest } = result;

    const lines: string[] = [];
    lines.push(`Agent: ${agent.name}  (id: ${agent.id})`);
    if (manifest.agent.resourceFiles.length > 0) {
      lines.push(`  resources:`);
      for (const r of manifest.agent.resourceFiles) {
        lines.push(`    - ${r.relPath} (${r.size}B)`);
      }
    }
    if (manifest.workforce.skills.length > 0) {
      lines.push(`  skills (workforce):`);
      for (const s of manifest.workforce.skills) {
        const detail =
          s.action === "failed" ? ` — ${s.error}` : "";
        lines.push(`    - ${s.name} · ${s.action}${detail}`);
      }
    }
    if (manifest.workforce.mcpServers.length > 0) {
      lines.push(`  mcp servers (workforce):`);
      for (const m of manifest.workforce.mcpServers) {
        lines.push(`    - ${m.name} · ${m.action}`);
      }
    }
    p.note(lines.join("\n"), `Imported '${templateId}'`);
  } catch (err) {
    p.cancel(
      `Import failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  } finally {
    await manager.close();
  }
}
