import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";
import { createAgentStore, loadConfig } from "@openacme/config";
import { MemoryStore, memoryAge } from "@openacme/memory";

export interface MemoryOptions {
  dataDir?: string;
}

function agentsDirOf(opts: MemoryOptions): string {
  const config = loadConfig(opts.dataDir);
  return path.join(config.dataDir, "agents");
}

/** Print one agent's MEMORY.md index + a list of entry files alongside. */
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
  const snapshot = memory.readIndex(agentId, def.memoryCharLimit);

  // Show the memory dir path so users know where to look.
  const dir = memory.dirPath(agentId);
  const indexPath = memory.indexPath(agentId);

  const sections: string[] = [];
  if (snapshot.content.length === 0) {
    sections.push(`(MEMORY.md is empty — no index entries yet)\n  ${indexPath}`);
  } else {
    const pct =
      snapshot.limit > 0
        ? Math.round((snapshot.used / snapshot.limit) * 100)
        : 0;
    sections.push(
      `MEMORY.md  [${pct}% — ${snapshot.used}/${snapshot.limit} chars]`
    );
    sections.push(snapshot.content);
  }

  // List entry files (siblings of MEMORY.md). Sorted newest first by mtime.
  type EntryRow = { name: string; mtimeMs: number; size: number };
  const entries: EntryRow[] = [];
  if (fs.existsSync(dir)) {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    for (const d of dirents) {
      if (!d.isFile() || !d.name.endsWith(".md") || d.name === "MEMORY.md")
        continue;
      const full = path.join(dir, d.name);
      try {
        const st = fs.statSync(full);
        entries.push({ name: d.name, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // ignore
      }
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (entries.length > 0) {
    sections.push(
      `Entry files (${entries.length}):\n` +
        entries
          .map(
            (e) =>
              `  ${e.name.padEnd(36)} ${memoryAge(e.mtimeMs).padEnd(14)} ${e.size}B`
          )
          .join("\n")
    );
  } else {
    sections.push(`(no entry files yet)`);
  }

  p.note(sections.join("\n\n"), `Memory — ${agentId}`);
}

/** Print one specific entry file (frontmatter + body), with freshness wrapper if old. */
export async function memoryShowEntryCommand(
  agentId: string,
  entryName: string,
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
  // Use store.view so we get the freshness wrapper for old entries.
  // Normalize the entry name to a /memories/ path.
  const virtualPath = entryName.startsWith("/memories/")
    ? entryName
    : `/memories/${entryName.replace(/^\//, "")}`;
  const out = memory.view(agentId, virtualPath);
  p.note(out, `Memory entry — ${agentId}: ${entryName}`);
}

/** Status across all agents — index size + entry count + utilization. */
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
    const s = memory.readIndex(def.id, def.memoryCharLimit);
    const pct =
      s.limit > 0 ? Math.round((s.used / s.limit) * 100) : 0;
    const entryWord = s.entryCount === 1 ? "entry" : "entries";
    return `  ${def.id.padEnd(24)} ${String(pct).padStart(3)}%  ${s.used}/${s.limit} chars  (${s.entryCount} ${entryWord})`;
  });
  p.note(
    lines.join("\n"),
    `Memory status — ${list.length} ${list.length === 1 ? "agent" : "agents"}`
  );
}

/** `view`-format directory listing — mirrors what the agent sees. */
export async function memoryLsCommand(
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
  const out = memory.view(agentId, "/memories");
  p.note(out, `Memory ls — ${agentId}`);
}
