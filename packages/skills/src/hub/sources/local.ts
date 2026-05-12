import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import type {
  SkillBundle,
  SkillBundleFile,
  SkillMeta,
  SkillSource,
  Tap,
  TrustLevel,
} from "../types.js";
import { sha256OfBundle } from "../content-hash.js";
import { validateBundlePath } from "../path-validation.js";

const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;

/**
 * Local-filesystem source.
 *
 * Two identifier shapes accepted:
 *   • Absolute path to a skill directory (used by CLI `skills add` and the
 *     `POST /api/skills/import` route — they stage to a temp dir and call
 *     `hub.install(tempDir, { source: "local" })`).
 *   • `<tapAbsolutePath>:<relSkillDir>` for skills discovered via a local
 *     tap. Less common; supports the Browse-tab path for users who pointed
 *     the hub at a clone of `anthropics/skills`.
 */
export class LocalSource implements SkillSource {
  readonly id = "local" as const;

  constructor(private readonly taps: () => Tap[]) {}

  trustLevelFor(): TrustLevel {
    return "community";
  }

  async search(
    query: string,
    opts: { limit?: number; signal?: AbortSignal } = {}
  ): Promise<SkillMeta[]> {
    const q = query.toLowerCase().trim();
    const limit = opts.limit ?? 25;
    const out: SkillMeta[] = [];
    for (const tap of this.taps().filter((t) => t.source === "local")) {
      try {
        const root = this.tapRoot(tap);
        if (!root) continue;
        for (const dir of this.findSkillDirs(root)) {
          if (out.length >= limit) return out;
          const meta = this.readMeta(root, dir);
          if (!meta) continue;
          if (
            q &&
            !meta.name.toLowerCase().includes(q) &&
            !meta.description.toLowerCase().includes(q) &&
            !meta.tags.some((t) => t.toLowerCase().includes(q))
          ) {
            continue;
          }
          out.push(meta);
        }
      } catch {
        // best-effort: a broken tap doesn't poison the rest
      }
    }
    return out;
  }

  async inspect(
    identifier: string,
    _opts: { signal?: AbortSignal } = {}
  ): Promise<SkillMeta | null> {
    const resolved = this.resolve(identifier);
    if (!resolved) return null;
    return this.readMeta(resolved.root, resolved.rel);
  }

  async fetch(
    identifier: string,
    _opts: { signal?: AbortSignal } = {}
  ): Promise<SkillBundle | null> {
    const resolved = this.resolve(identifier);
    if (!resolved) return null;
    const skillRoot = path.join(resolved.root, resolved.rel);
    if (!fs.existsSync(path.join(skillRoot, "SKILL.md"))) return null;
    const files = this.collectFiles(skillRoot);
    if (files.length === 0) return null;
    const meta = this.readMeta(resolved.root, resolved.rel);
    return {
      name: meta?.name ?? path.basename(skillRoot),
      files,
      source: "local",
      sourceIdentifier: identifier,
      resolvedRef: "",
      contentHash: sha256OfBundle(files),
    };
  }

  // -------------------------------------------------------------------------

  /** Resolve an identifier to `{ root, rel }` where root+rel = skill dir. */
  private resolve(identifier: string): { root: string; rel: string } | null {
    if (!identifier) return null;
    // Absolute-path form: identifier IS the skill directory.
    if (path.isAbsolute(identifier)) {
      if (!fs.existsSync(identifier)) return null;
      const real = fs.realpathSync(identifier);
      const root = path.dirname(real);
      const rel = path.basename(real);
      return { root, rel };
    }
    // Tap-relative form: "<tapPath>:<relSkillDir>"
    const sep = identifier.lastIndexOf(":");
    if (sep > 0) {
      const tapPath = identifier.slice(0, sep);
      const rel = identifier.slice(sep + 1);
      if (path.isAbsolute(tapPath) && rel && !rel.includes("..")) {
        const tap = this.taps().find(
          (t) => t.source === "local" && t.repo === tapPath
        );
        if (!tap) return null;
        const root = this.tapRoot(tap);
        if (!root) return null;
        return { root, rel };
      }
    }
    return null;
  }

  private tapRoot(tap: Tap): string | null {
    const root = tap.path ? path.join(tap.repo, tap.path) : tap.repo;
    if (!fs.existsSync(root)) return null;
    return fs.realpathSync(root);
  }

  private findSkillDirs(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (fs.existsSync(path.join(full, "SKILL.md"))) {
          out.push(path.relative(root, full));
          continue;
        }
        walk(full, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }

  private readMeta(root: string, rel: string): SkillMeta | null {
    const skillMdPath = path.join(root, rel, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) return null;
    let text: string;
    try {
      text = fs.readFileSync(skillMdPath, "utf-8");
    } catch {
      return null;
    }
    const { data } = matter(text);
    const fm = data as Record<string, unknown>;
    const name = typeof fm["name"] === "string"
      ? fm["name"]
      : path.basename(rel);
    if (!name) return null;
    return {
      name,
      description: typeof fm["description"] === "string" ? fm["description"] : "",
      source: "local",
      identifier: `${root}:${rel}`,
      trustLevel: "community",
      path: rel,
      tags: Array.isArray(fm["tags"])
        ? (fm["tags"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      extra: {},
    };
  }

  private collectFiles(skillRoot: string): SkillBundleFile[] {
    const out: SkillBundleFile[] = [];
    let total = 0;
    const walk = (dir: string, prefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_FILES) return;
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(full, rel);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          validateBundlePath(rel);
        } catch {
          continue;
        }
        const bytes = fs.readFileSync(full);
        total += bytes.length;
        if (total > MAX_TOTAL_BYTES) {
          throw new Error(`bundle exceeds ${MAX_TOTAL_BYTES} bytes`);
        }
        out.push({ relPath: rel, bytes: new Uint8Array(bytes) });
      }
    };
    walk(skillRoot, "");
    return out;
  }
}
