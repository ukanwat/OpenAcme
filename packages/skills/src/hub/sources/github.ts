import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import matter from "gray-matter";
import { downloadTemplate } from "giget";
import { createLogger } from "@openacme/config/logger";
import type {
  SkillBundle,
  SkillBundleFile,
  SkillMeta,
  SkillSource,
  TrustLevel,
} from "../types.js";

const log = createLogger("skills.hub.github");
import type { GitHubAuth } from "../github-auth.js";
import type { IndexCache } from "../index-cache.js";
import type { Tap } from "../types.js";
import { validateBundlePath } from "../path-validation.js";
import { sha256OfBundle } from "../content-hash.js";

const TRUSTED_REPOS = new Set<string>(["anthropics/skills"]);

const RAW_BASE = "https://raw.githubusercontent.com";
const API_BASE = "https://api.github.com";
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

interface RepoMeta {
  defaultBranch: string;
}

/** Parse `owner/repo[/path/to/skill]`. */
function parseIdentifier(identifier: string): {
  owner: string;
  repo: string;
  path: string;
} | null {
  const parts = identifier.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!;
  if (!owner || !repo) return null;
  const path = parts.slice(2).join("/");
  return { owner, repo, path };
}

export class GitHubSource implements SkillSource {
  readonly id = "github" as const;

  constructor(
    private readonly auth: GitHubAuth,
    private readonly cache: IndexCache,
    private readonly taps: () => Tap[]
  ) {}

  trustLevelFor(identifier: string): TrustLevel {
    const p = parseIdentifier(identifier);
    if (!p) return "community";
    return TRUSTED_REPOS.has(`${p.owner}/${p.repo}`) ? "trusted" : "community";
  }

  async search(
    query: string,
    opts: { limit?: number; signal?: AbortSignal } = {}
  ): Promise<SkillMeta[]> {
    const q = query.toLowerCase().trim();
    const limit = opts.limit ?? 25;
    const results: SkillMeta[] = [];
    const seen = new Set<string>();

    const matches = (meta: SkillMeta): boolean =>
      !q ||
      meta.name.toLowerCase().includes(q) ||
      meta.description.toLowerCase().includes(q) ||
      meta.tags.some((t) => t.toLowerCase().includes(q));

    for (const tap of this.taps().filter((t) => t.source === "github")) {
      try {
        const skillPaths = await this.listSkillPaths(tap, opts.signal);
        // One tap can hold many skills; inspecting each is an independent
        // HTTPS round-trip. Run them in parallel so a 50-skill tap doesn't
        // serialize into 50 sequential fetches.
        const ids = skillPaths
          .map((p) => `${tap.repo}/${p}`)
          .filter((id) => !seen.has(id));
        const metas = await Promise.all(
          ids.map((id) =>
            this.inspect(id, { signal: opts.signal }).catch(() => null)
          )
        );
        for (const meta of metas) {
          if (results.length >= limit) break;
          if (!meta || seen.has(meta.identifier)) continue;
          if (!matches(meta)) continue;
          seen.add(meta.identifier);
          results.push(meta);
        }
      } catch (err) {
        log.warn({ err, tap: tap.repo }, "tap search failed");
      }
      if (results.length >= limit) break;
    }

    return results;
  }

  async inspect(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillMeta | null> {
    const p = parseIdentifier(identifier);
    if (!p) return null;
    const branch = await this.defaultBranch(p.owner, p.repo, opts.signal);
    if (!branch) return null;
    const skillDir = p.path.endsWith("/SKILL.md")
      ? p.path.slice(0, -"/SKILL.md".length)
      : p.path;
    const fullSkillPath = skillDir ? `${skillDir}/SKILL.md` : "SKILL.md";
    const url = `${RAW_BASE}/${p.owner}/${p.repo}/${branch}/${fullSkillPath}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "openacme-skills-hub" },
      signal: opts.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    const { data } = matter(text);
    const fm = data as Record<string, unknown>;
    const name = typeof fm["name"] === "string"
      ? fm["name"]
      : skillDir.split("/").pop() ?? "";
    if (!name) return null;
    return {
      name,
      description: typeof fm["description"] === "string" ? fm["description"] : "",
      source: "github",
      identifier: `${p.owner}/${p.repo}${skillDir ? "/" + skillDir : ""}`,
      trustLevel: TRUSTED_REPOS.has(`${p.owner}/${p.repo}`) ? "trusted" : "community",
      repo: `${p.owner}/${p.repo}`,
      path: skillDir,
      tags: Array.isArray(fm["tags"])
        ? (fm["tags"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      extra: {},
    };
  }

  async fetch(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillBundle | null> {
    const p = parseIdentifier(identifier);
    if (!p) return null;
    const branch = await this.defaultBranch(p.owner, p.repo, opts.signal);
    if (!branch) return null;
    const skillDir = p.path.endsWith("/SKILL.md")
      ? p.path.slice(0, -"/SKILL.md".length)
      : p.path;

    // Use giget to pull a tarball of the subdirectory.
    const giverTpl = skillDir
      ? `github:${p.owner}/${p.repo}/${skillDir}#${branch}`
      : `github:${p.owner}/${p.repo}#${branch}`;
    const tmpRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openacme-hub-")
    );
    let files: SkillBundleFile[] = [];
    let resolvedRef = "";
    try {
      const result = await downloadTemplate(giverTpl, {
        dir: tmpRoot,
        force: true,
        install: false,
        // giget caches in its own dir; we don't need to leak that here.
      });
      resolvedRef = result.source ?? "";
      files = await this.collectFiles(tmpRoot);

      // If giget returned nothing (rare — happens with deep nested
      // paths giget can't slice), fall back to per-file Contents API.
      if (files.length === 0) {
        files = await this.contentsApiFallback(
          p.owner,
          p.repo,
          branch,
          skillDir,
          opts.signal
        );
      }
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }

    if (files.length === 0) return null;
    const hasSkillMd = files.some((f) => f.relPath === "SKILL.md");
    if (!hasSkillMd) return null;

    const meta = await this.inspect(identifier, opts);
    const name = meta?.name ?? identifier.split("/").pop() ?? "skill";

    return {
      name,
      files,
      source: "github",
      sourceIdentifier: `${p.owner}/${p.repo}${skillDir ? "/" + skillDir : ""}`,
      resolvedRef,
      contentHash: sha256OfBundle(files),
    };
  }

  // -------------------------------------------------------------------------

  private async listSkillPaths(
    tap: Tap,
    signal?: AbortSignal
  ): Promise<string[]> {
    const cacheKey = `gh-tree:${tap.repo}:${tap.path}`;
    const cached = this.cache.read<string[]>(cacheKey);
    if (cached) return cached;

    const [owner, repo] = tap.repo.split("/");
    if (!owner || !repo) return [];
    const branch = await this.defaultBranch(owner, repo, signal);
    if (!branch) return [];

    const url = `${API_BASE}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    const res = await fetch(url, { headers: this.auth.headers(), signal });
    if (!res.ok) return [];
    const json = (await res.json()) as { tree?: TreeEntry[]; truncated?: boolean };
    const tree = json.tree ?? [];
    const prefix = tap.path.replace(/^\/+|\/+$/g, "");
    const out: string[] = [];
    for (const entry of tree) {
      if (entry.type !== "blob") continue;
      if (!entry.path.endsWith("/SKILL.md") && entry.path !== "SKILL.md") continue;
      if (prefix && !entry.path.startsWith(prefix + "/") && entry.path !== prefix + "/SKILL.md") {
        // Skill paths must live under the tap's configured subpath.
        continue;
      }
      // Convert "<dir>/SKILL.md" → "<dir>"
      const skillDir = entry.path.slice(0, -"/SKILL.md".length);
      out.push(skillDir);
    }
    this.cache.write(cacheKey, out);
    return out;
  }

  private async defaultBranch(
    owner: string,
    repo: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const cacheKey = `gh-repo-meta:${owner}/${repo}`;
    const cached = this.cache.read<RepoMeta>(cacheKey);
    if (cached) return cached.defaultBranch;
    const url = `${API_BASE}/repos/${owner}/${repo}`;
    const res = await fetch(url, { headers: this.auth.headers(), signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { default_branch?: string };
    if (!json.default_branch) return null;
    this.cache.write(cacheKey, { defaultBranch: json.default_branch });
    return json.default_branch;
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

  private async contentsApiFallback(
    owner: string,
    repo: string,
    branch: string,
    skillDir: string,
    signal?: AbortSignal
  ): Promise<SkillBundleFile[]> {
    // Recursively walks the Contents API for skill directories giget
    // can't slice (rare, but possible for some deep paths).
    const out: SkillBundleFile[] = [];
    let total = 0;

    const walk = async (relPath: string): Promise<void> => {
      const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeURI(relPath)}?ref=${encodeURIComponent(branch)}`;
      const res = await fetch(url, { headers: this.auth.headers(), signal });
      if (!res.ok) return;
      const body = (await res.json()) as
        | { type: string; name: string; path: string; content?: string; encoding?: string; size?: number }
        | Array<{ type: string; name: string; path: string }>;
      if (Array.isArray(body)) {
        for (const entry of body) {
          if (entry.name.startsWith(".")) continue;
          if (entry.type === "dir") {
            await walk(entry.path);
          } else if (entry.type === "file") {
            await walk(entry.path);
          }
          if (out.length >= MAX_FILES) return;
        }
        return;
      }
      if (body.type !== "file") return;
      if (!body.content || body.encoding !== "base64") return;
      const bytes = Buffer.from(body.content, "base64");
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) {
        throw new Error(`bundle exceeds ${MAX_TOTAL_BYTES} bytes`);
      }
      const rel = skillDir
        ? body.path.slice(skillDir.length + 1)
        : body.path;
      try {
        validateBundlePath(rel);
      } catch {
        return;
      }
      out.push({ relPath: rel, bytes: new Uint8Array(bytes) });
    };

    await walk(skillDir);
    return out;
  }
}
