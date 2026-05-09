import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";
import { createAgentStore, loadConfig } from "@openacme/config";
import { MemoryStore } from "@openacme/memory";

export interface MemoryOptions {
  dataDir?: string;
}

function agentsDirOf(opts: MemoryOptions): string {
  const config = loadConfig(opts.dataDir);
  return path.join(config.dataDir, "agents");
}

export async function memoryShowCommand(
  agentId: string,
  opts: MemoryOptions
): Promise<void> {
  const agentsDir = agentsDirOf(opts);
  const agents = createAgentStore(agentsDir);
  const def = agents.get(agentId);
  if (!def) {
    p.cancel(`Agent not found: ${agentId}`);
    process.exitCode = 1;
    return;
  }
  const memory = new MemoryStore(agentsDir);
  const rendered = memory.renderForPrompt(agentId, def.memoryCharLimit);
  if (!rendered) {
    p.note(
      `No memory entries yet for agent '${agentId}'.\n\n` +
        `Memory file path:\n  ${memory.filePath(agentId)}`,
      "Memory"
    );
    return;
  }
  p.note(rendered, `Memory — ${agentId}`);
}

export async function memoryStatusCommand(
  opts: MemoryOptions
): Promise<void> {
  const agentsDir = agentsDirOf(opts);
  if (!fs.existsSync(agentsDir)) {
    p.note(
      `No agents directory at ${agentsDir}.\n\nRun 'openacme setup' to create your first agent.`,
      "Memory"
    );
    return;
  }
  const agents = createAgentStore(agentsDir);
  const list = agents.list();
  if (list.length === 0) {
    p.note(`No agents found in ${agentsDir}.`, "Memory");
    return;
  }
  const memory = new MemoryStore(agentsDir);
  const lines = list.map((def) => {
    const u = memory.usage(def.id, def.memoryCharLimit);
    const pct = u.limit > 0 ? Math.round((u.used / u.limit) * 100) : 0;
    return `  ${def.id.padEnd(24)} ${String(pct).padStart(3)}%  ${u.used}/${u.limit} chars  (${u.entries.length} ${u.entries.length === 1 ? "entry" : "entries"})`;
  });
  p.note(lines.join("\n"), `Memory status — ${list.length} ${list.length === 1 ? "agent" : "agents"}`);
}
