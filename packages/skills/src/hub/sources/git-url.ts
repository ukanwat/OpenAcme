import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import matter from "gray-matter";
import { downloadTemplate } from "giget";
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
 * Generic git source for non-GitHub hosts (GitLab, Bitbucket, Gitea via
 * https://...git, etc.). Uses giget's native protocol prefixes.
 *
 * Identifier shape: anything giget accepts. Common forms:
 *   • gitlab:owner/repo[/path]#ref
 *   • bitbucket:owner/repo[/path]#ref
 *   • https://gitea.example.com/owner/repo.git
 *
 * Direct-fetch only — no taps, no search. Users must supply the exact
 * identifier from the Browse tab or CLI.
 */
export class GitUrlSource implements SkillSource {
  readonly id = "git-url" as const;

  trustLevelFor(): TrustLevel {
    return "community";
  }

  async search(): Promise<SkillMeta[]> {
    return [];
  }

  async inspect(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillMeta | null> {
    // No cheap inspect path for arbitrary git hosts — pull the bundle,
    // read its SKILL.md, return the metadata. Heavier than ideal but
    // identifier-driven so only invoked when the user explicitly asks.
    const bundle = await this.fetch(identifier, opts);
    if (!bundle) return null;
    const skillMd = bundle.files.find((f) => f.relPath === "SKILL.md");
    if (!skillMd) return null;
    const { data } = matter(new TextDecoder().decode(skillMd.bytes));
    const fm = data as Record<string, unknown>;
    const name = typeof fm["name"] === "string" ? fm["name"] : bundle.name;
    return {
      name,
      description: typeof fm["description"] === "string" ? fm["description"] : "",
      source: "git-url",
      identifier,
      trustLevel: "community",
      tags: Array.isArray(fm["tags"])
        ? (fm["tags"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      extra: {},
    };
  }

  async fetch(
    identifier: string,
    _opts: { signal?: AbortSignal } = {}
  ): Promise<SkillBundle | null> {
    if (!this.looksLikeGitUrl(identifier)) return null;

    const tmpRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openacme-git-")
    );
    let resolvedRef = "";
    let files: SkillBundleFile[] = [];
    try {
      const result = await downloadTemplate(identifier, {
        dir: tmpRoot,
        force: true,
        install: false,
      });
      resolvedRef = result.source ?? "";
      files = await this.collectFiles(tmpRoot);
    } catch {
      return null;
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }

    if (!files.some((f) => f.relPath === "SKILL.md")) return null;

    const skillMd = files.find((f) => f.relPath === "SKILL.md")!;
    const { data } = matter(new TextDecoder().decode(skillMd.bytes));
    const fm = data as Record<string, unknown>;
    const tail = identifier
      .replace(/\.git(?:#.*)?$/, "")
      .split(/[/:#]/)
      .filter(Boolean)
      .pop();
    const name = typeof fm["name"] === "string" ? fm["name"] : (tail ?? "skill");

    return {
      name,
      files,
      source: "git-url",
      sourceIdentifier: identifier,
      resolvedRef,
      contentHash: sha256OfBundle(files),
    };
  }

  // -------------------------------------------------------------------------

  /** Quick check that an identifier is plausibly a git URL giget can handle. */
  looksLikeGitUrl(identifier: string): boolean {
    if (/^(gitlab|bitbucket|sourcehut|github):/i.test(identifier)) return true;
    if (/^https?:\/\/.+\.git(?:#|$)/i.test(identifier)) return true;
    return false;
  }

  private async collectFiles(root: string): Promise<SkillBundleFile[]> {
    const out: SkillBundleFile[] = [];
    let total = 0;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (out.length >= MAX_FILES) return;
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(full, rel);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          validateBundlePath(rel);
        } catch {
          continue;
        }
        const bytes = await fs.promises.readFile(full);
        total += bytes.length;
        if (total > MAX_TOTAL_BYTES) {
          throw new Error(`bundle exceeds ${MAX_TOTAL_BYTES} bytes`);
        }
        out.push({ relPath: rel, bytes: new Uint8Array(bytes) });
      }
    };
    await walk(root, "");
    return out;
  }
}
