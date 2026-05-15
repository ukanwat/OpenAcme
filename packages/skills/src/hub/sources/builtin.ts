import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import type {
  SkillBundle,
  SkillBundleFile,
  SkillMeta,
  SkillSource,
  TrustLevel,
} from "../types.js";
import { sha256OfBundle } from "../content-hash.js";
import { validateBundlePath } from "../path-validation.js";

const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;

/**
 * Bundled-with-platform skills. Identifier is the skill folder name.
 *
 * Resolves against `<packageRoot>/builtin/<identifier>/SKILL.md`. The
 * `builtin/` directory ships via the package's `files` array and is
 * located relative to this module at runtime (works in both `src/` dev
 * and `dist/` published shapes — two levels up either way).
 */
export class BuiltinSource implements SkillSource {
  readonly id = "builtin" as const;

  private readonly root: string;

  constructor(rootOverride?: string) {
    this.root = rootOverride ?? defaultBuiltinRoot();
  }

  trustLevelFor(): TrustLevel {
    return "trusted";
  }

  async search(
    query: string,
    opts: { limit?: number; signal?: AbortSignal } = {}
  ): Promise<SkillMeta[]> {
    if (!fs.existsSync(this.root)) return [];
    const q = query.toLowerCase().trim();
    const limit = opts.limit ?? 25;
    const out: SkillMeta[] = [];
    for (const name of this.listSkillDirs()) {
      if (out.length >= limit) break;
      const meta = this.readMeta(name);
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
    return out;
  }

  async inspect(
    identifier: string,
    _opts: { signal?: AbortSignal } = {}
  ): Promise<SkillMeta | null> {
    return this.readMeta(identifier);
  }

  async fetch(
    identifier: string,
    _opts: { signal?: AbortSignal } = {}
  ): Promise<SkillBundle | null> {
    const skillRoot = this.skillDir(identifier);
    if (!skillRoot) return null;
    if (!fs.existsSync(path.join(skillRoot, "SKILL.md"))) return null;
    const files = this.collectFiles(skillRoot);
    if (files.length === 0) return null;
    const meta = this.readMeta(identifier);
    return {
      name: meta?.name ?? identifier,
      files,
      source: "builtin",
      sourceIdentifier: identifier,
      resolvedRef: "",
      contentHash: sha256OfBundle(files),
    };
  }

  // -------------------------------------------------------------------------

  private skillDir(identifier: string): string | null {
    if (!identifier || identifier.includes("/") || identifier.includes("\\")) {
      return null;
    }
    if (identifier === "." || identifier === ".." || identifier.startsWith(".")) {
      return null;
    }
    const dir = path.join(this.root, identifier);
    if (!fs.existsSync(dir)) return null;
    if (!fs.statSync(dir).isDirectory()) return null;
    return dir;
  }

  private listSkillDirs(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  }

  private readMeta(identifier: string): SkillMeta | null {
    const dir = this.skillDir(identifier);
    if (!dir) return null;
    const skillMdPath = path.join(dir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) return null;
    let text: string;
    try {
      text = fs.readFileSync(skillMdPath, "utf-8");
    } catch {
      return null;
    }
    const { data } = matter(text);
    const fm = data as Record<string, unknown>;
    const name =
      typeof fm["name"] === "string" && fm["name"] ? fm["name"] : identifier;
    return {
      name,
      description:
        typeof fm["description"] === "string" ? fm["description"] : "",
      source: "builtin",
      identifier,
      trustLevel: "trusted",
      tags: Array.isArray(fm["tags"])
        ? (fm["tags"] as unknown[]).filter(
            (x): x is string => typeof x === "string"
          )
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

function defaultBuiltinRoot(): string {
  // src/hub/sources/builtin.ts → ../../../builtin/
  // dist/hub/sources/builtin.js → ../../../builtin/
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "builtin");
}
