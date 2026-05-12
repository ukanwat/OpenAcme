import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";
import { loadConfig } from "@openacme/config";
import { SkillRegistry, SkillHub, HubError, type SkillSourceId } from "@openacme/skills";

export interface SkillsHubOptions {
  dataDir?: string;
  source?: string;
  force?: boolean;
  name?: string;
  limit?: number;
  action?: string;
  path?: string;
  yes?: boolean;
}

function makeHub(opts: SkillsHubOptions): SkillHub {
  const config = loadConfig(opts.dataDir);
  const skillsDir = path.isAbsolute(config.skills.directory)
    ? config.skills.directory
    : path.join(config.dataDir, config.skills.directory);
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
  const reg = new SkillRegistry();
  reg.loadFromDirectory(skillsDir);
  return new SkillHub(skillsDir, reg);
}

function sourceId(v: unknown): SkillSourceId | undefined {
  if (v === "github" || v === "url" || v === "claude-marketplace") return v;
  return undefined;
}

function sourceFilter(v: unknown): "all" | SkillSourceId | undefined {
  if (v === "all") return "all";
  return sourceId(v);
}

export async function skillsHubInstallCommand(
  identifier: string,
  opts: SkillsHubOptions
): Promise<void> {
  const hub = makeHub(opts);
  const spin = p.spinner();
  spin.start(`Installing ${identifier}…`);
  try {
    const result = await hub.install(identifier, {
      source: sourceId(opts.source),
      nameOverride: opts.name,
      force: Boolean(opts.force),
    });
    spin.stop(
      `Installed '${result.name}' (${result.lockEntry.source}/${result.lockEntry.trustLevel}, ${result.contentHash})`
    );
  } catch (err) {
    spin.stop("Install failed");
    if (err instanceof HubError) {
      p.cancel(`${err.code}: ${err.message}`);
    } else {
      p.cancel(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  }
}

export async function skillsHubSearchCommand(
  query: string,
  opts: SkillsHubOptions
): Promise<void> {
  const hub = makeHub(opts);
  const spin = p.spinner();
  spin.start(`Searching "${query}"…`);
  try {
    const results = await hub.search(query, {
      source: sourceFilter(opts.source),
      limit: opts.limit,
    });
    spin.stop(`${results.length} result${results.length === 1 ? "" : "s"}`);
    if (results.length === 0) {
      p.note("No matches. Try a broader query or `skills tap add <repo>`.", "Search");
      return;
    }
    const lines = results.map(
      (r) =>
        `  ${r.name} [${r.source}/${r.trustLevel}]\n` +
        `    ${r.description.slice(0, 200)}\n` +
        `    ${r.identifier}`
    );
    p.note(lines.join("\n\n"), `Hub: ${query}`);
  } catch (err) {
    spin.stop("Search failed");
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function skillsHubInspectCommand(
  identifier: string,
  opts: SkillsHubOptions
): Promise<void> {
  const hub = makeHub(opts);
  const spin = p.spinner();
  spin.start(`Inspecting ${identifier}…`);
  try {
    const meta = await hub.inspect(identifier, {
      source: sourceId(opts.source),
    });
    spin.stop("Done");
    if (!meta) {
      p.cancel(`Not found: ${identifier}`);
      process.exitCode = 1;
      return;
    }
    const tags = meta.tags.length > 0 ? `\ntags: ${meta.tags.join(", ")}` : "";
    p.note(
      `name: ${meta.name}\n` +
        `description: ${meta.description}\n` +
        `source: ${meta.source}\n` +
        `identifier: ${meta.identifier}\n` +
        `trust: ${meta.trustLevel}` +
        tags,
      "Skill"
    );
  } catch (err) {
    spin.stop("Inspect failed");
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function skillsHubUpdateCommand(
  name: string | undefined,
  opts: SkillsHubOptions
): Promise<void> {
  const hub = makeHub(opts);
  const spin = p.spinner();
  spin.start(name ? `Updating '${name}'…` : "Updating all hub-installed skills…");
  try {
    const result = await hub.update(name);
    const parts: string[] = [];
    if (result.updated.length > 0) parts.push(`updated: ${result.updated.join(", ")}`);
    if (result.unchanged.length > 0) parts.push(`unchanged: ${result.unchanged.join(", ")}`);
    if (result.failed.length > 0)
      parts.push(`failed: ${result.failed.map((f) => `${f.name} (${f.reason})`).join(", ")}`);
    spin.stop("Done");
    p.note(parts.length > 0 ? parts.join("\n") : "Nothing to do.", "Update");
  } catch (err) {
    spin.stop("Update failed");
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function skillsHubUninstallCommand(
  name: string,
  opts: SkillsHubOptions
): Promise<void> {
  const hub = makeHub(opts);
  const entry = hub.lockfile.get(name);
  if (!entry) {
    p.cancel(`'${name}' is not installed via the hub. Use 'skills remove' for locally-authored skills.`);
    process.exitCode = 1;
    return;
  }
  if (!opts.yes) {
    const ok = await p.confirm({
      message: `Uninstall '${name}' (source: ${entry.source}/${entry.identifier})?`,
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) {
      p.cancel("Aborted.");
      return;
    }
  }
  hub.uninstall(name);
  p.outro(`Uninstalled '${name}'.`);
}

export async function skillsHubAuditCommand(
  opts: SkillsHubOptions
): Promise<void> {
  const hub = makeHub(opts);
  const rows = hub.readAudit({
    limit: opts.limit,
    action: opts.action as
      | "INSTALL"
      | "INSTALL_FAILED"
      | "UPDATE"
      | "UPDATE_FAILED"
      | "UNINSTALL"
      | "UNINSTALL_FAILED"
      | "TAP_ADD"
      | "TAP_REMOVE"
      | undefined,
  });
  if (rows.length === 0) {
    p.note("No audit rows.", "Audit");
    return;
  }
  const lines = rows.map((r) => {
    const tag = `${r.outcome === "ok" ? "✓" : "✗"} ${r.ts} ${r.action}`;
    const detail = [
      r.name ? `name=${r.name}` : null,
      r.source ? `src=${r.source}` : null,
      r.identifier ? `id=${r.identifier}` : null,
      r.contentHash ? `hash=${r.contentHash}` : null,
      r.repo ? `repo=${r.repo}` : null,
      r.reason ? `reason=${r.reason}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return `  ${tag}  ${detail}`;
  });
  p.note(lines.join("\n"), "Audit");
}

export async function tapListCommand(opts: SkillsHubOptions): Promise<void> {
  const hub = makeHub(opts);
  const taps = hub.listTaps();
  if (taps.length === 0) {
    p.note("No taps configured.", "Taps");
    return;
  }
  const lines = taps.map((t) => `  ${t.source.padEnd(20)}  ${t.repo}  (${t.path})`);
  p.note(lines.join("\n"), `Taps (${taps.length})`);
}

export async function tapAddCommand(
  repo: string,
  opts: SkillsHubOptions
): Promise<void> {
  if (opts.source && opts.source !== "github" && opts.source !== "claude-marketplace") {
    p.cancel(`--source must be 'github' or 'claude-marketplace', got '${opts.source}'`);
    process.exitCode = 1;
    return;
  }
  const source = (opts.source ?? "github") as "github" | "claude-marketplace";
  const hub = makeHub(opts);
  try {
    const tap = hub.addTap({ source, repo, path: opts.path });
    p.outro(`Added tap: ${tap.source} ${tap.repo} (${tap.path})`);
  } catch (err) {
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function tapRemoveCommand(
  repo: string,
  opts: SkillsHubOptions
): Promise<void> {
  const hub = makeHub(opts);
  const ok = hub.removeTap(repo);
  if (!ok) {
    p.cancel(`Tap not found: ${repo}`);
    process.exitCode = 1;
    return;
  }
  p.outro(`Removed tap: ${repo}`);
}
