import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A file under an agent's `resources/` subdir. Mirror of
 * `SkillResource` from `@openacme/skills`. Contents are NOT read; the
 * agent picks them up via `read_file` against `path`.
 */
export interface AgentResource {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to `<agentDir>/resources/` (POSIX-style). */
  relPath: string;
  /** Size in bytes. */
  size: number;
}

export const MAX_RESOURCES_PER_AGENT = 200;

/**
 * List every file under `<agentDir>/resources/`, recursively.
 * Dotfiles and dot-directories are skipped. Missing dir → `[]`.
 *
 * Structure mirrors `discoverResources()` / `walk()` in
 * `packages/skills/src/parser.ts`. No exclusion list — the entire
 * `resources/` subtree is fair game.
 */
export function listAgentResources(agentDir: string): AgentResource[] {
  const resourcesDir = path.join(agentDir, "resources");
  if (!fs.existsSync(resourcesDir)) return [];
  const out: AgentResource[] = [];
  walk(resourcesDir, resourcesDir, out);
  return out;
}

function walk(
  rootDir: string,
  currentDir: string,
  out: AgentResource[]
): void {
  if (out.length >= MAX_RESOURCES_PER_AGENT) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_RESOURCES_PER_AGENT) return;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(rootDir, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    const rel = path.relative(rootDir, full).split(path.sep).join("/");
    out.push({ path: full, relPath: rel, size });
  }
}

/**
 * Validate a POSIX relPath under `<agentDir>/resources/` and return the
 * absolute on-disk path. Rejects traversal and dotfile segments.
 * Returns `null` for invalid input.
 */
export function resolveResourcePath(
  agentDir: string,
  relPath: string
): string | null {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  // Normalize: POSIX separators only, no leading slash, no NUL.
  if (relPath.includes("\0") || relPath.startsWith("/")) return null;
  const normalized = relPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  for (const seg of parts) {
    if (seg.length === 0) return null;
    if (seg === "." || seg === "..") return null;
    if (seg.startsWith(".")) return null;
  }
  const resourcesDir = path.join(agentDir, "resources");
  const abs = path.resolve(path.join(resourcesDir, parts.join(path.sep)));
  const root = path.resolve(resourcesDir);
  if (!(abs === root || abs.startsWith(root + path.sep))) return null;
  return abs;
}
