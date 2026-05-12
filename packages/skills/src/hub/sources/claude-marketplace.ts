import type {
  SkillBundle,
  SkillMeta,
  SkillSource,
  Tap,
  TrustLevel,
} from "../types.js";
import type { GitHubAuth } from "../github-auth.js";
import type { IndexCache } from "../index-cache.js";
import type { GitHubSource } from "./github.js";

const API_BASE = "https://api.github.com";
const TRUSTED_REPOS = new Set<string>(["anthropics/skills"]);

interface MarketplacePlugin {
  name?: string;
  description?: string;
  source?: string | { source?: string; repo?: string; path?: string };
  tags?: string[];
}

interface MarketplaceJson {
  plugins?: MarketplacePlugin[];
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
}

/**
 * Claude marketplaces serve *plugins*, not skills directly. A plugin is a
 * directory containing a `.claude-plugin/` manifest and any of `agents/`,
 * `commands/`, or `skills/`. The plugin root has no SKILL.md.
 *
 * To expose skills via the marketplace pathway, we cross-reference the
 * `.claude-plugin/marketplace.json` plugin list with the repo's git tree,
 * yielding one SkillMeta per `<plugin>/skills/<skill>/SKILL.md` found.
 * Plugins without a `skills/` subfolder produce no results.
 *
 * Inspect + fetch delegate to GitHubSource using the full nested path.
 */
export class ClaudeMarketplaceSource implements SkillSource {
  readonly id = "claude-marketplace" as const;

  constructor(
    private readonly github: GitHubSource,
    private readonly auth: GitHubAuth,
    private readonly cache: IndexCache,
    private readonly taps: () => Tap[]
  ) {}

  trustLevelFor(identifier: string): TrustLevel {
    const repo = identifier.split("/").slice(0, 2).join("/");
    return TRUSTED_REPOS.has(repo) ? "trusted" : "community";
  }

  async search(
    query: string,
    opts: { limit?: number; signal?: AbortSignal } = {}
  ): Promise<SkillMeta[]> {
    const q = query.toLowerCase().trim();
    const limit = opts.limit ?? 25;
    const out: SkillMeta[] = [];
    const seen = new Set<string>();

    for (const tap of this.taps().filter((t) => t.source === "claude-marketplace")) {
      try {
        const entries = await this.loadMarketplaceSkills(tap.repo, opts.signal);
        for (const entry of entries) {
          if (out.length >= limit) break;
          if (seen.has(entry.identifier)) continue;
          if (
            q &&
            !entry.name.toLowerCase().includes(q) &&
            !entry.description.toLowerCase().includes(q) &&
            !entry.tags.some((t) => t.toLowerCase().includes(q))
          ) {
            continue;
          }
          seen.add(entry.identifier);
          out.push(entry);
        }
      } catch (err) {
        console.warn(
          `ClaudeMarketplaceSource: tap ${tap.repo} search failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  async inspect(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillMeta | null> {
    const m = await this.github.inspect(identifier, opts);
    if (!m) return null;
    return { ...m, source: "claude-marketplace" };
  }

  async fetch(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillBundle | null> {
    const b = await this.github.fetch(identifier, opts);
    if (!b) return null;
    return { ...b, source: "claude-marketplace" };
  }

  // -------------------------------------------------------------------------

  /**
   * Load the marketplace.json + git tree once, then enumerate every
   * `<plugin>/skills/<name>/SKILL.md` under any plugin advertised in the
   * marketplace. Each becomes a SkillMeta.
   */
  private async loadMarketplaceSkills(
    repo: string,
    signal?: AbortSignal
  ): Promise<SkillMeta[]> {
    const cacheKey = `claude-marketplace-skills:${repo}`;
    const cached = this.cache.read<SkillMeta[]>(cacheKey);
    if (cached) return cached;

    const manifest = await this.loadManifest(repo, signal);
    if (!manifest) {
      this.cache.write(cacheKey, []);
      return [];
    }
    const tree = await this.loadTree(repo, signal);
    if (!tree) {
      this.cache.write(cacheKey, []);
      return [];
    }

    const trusted = TRUSTED_REPOS.has(repo);
    const out: SkillMeta[] = [];

    // Pre-compute SKILL.md paths from the tree for O(plugins) filtering.
    const skillPaths = tree
      .filter((e) => e.type === "blob" && e.path.endsWith("/SKILL.md"))
      .map((e) => e.path);

    for (const plugin of manifest.plugins ?? []) {
      const pluginPath = this.pluginPath(repo, plugin.source);
      if (!pluginPath) continue;
      // Both `<plugin>/skills/<name>/SKILL.md` (typical) and a SKILL.md at
      // the plugin root itself are honored, in case a plugin author chose
      // to ship a single skill without the `skills/` wrapper.
      const skillsPrefix = `${pluginPath}/skills/`;
      const pluginPrefix = `${pluginPath}/`;
      for (const fullPath of skillPaths) {
        if (
          !fullPath.startsWith(skillsPrefix) &&
          fullPath !== `${pluginPath}/SKILL.md`
        ) {
          continue;
        }
        const skillDir = fullPath.slice(0, -"/SKILL.md".length);
        const skillName = skillDir.split("/").pop() ?? "";
        if (!skillName) continue;
        const identifier = `${repo}/${skillDir}`;
        out.push({
          name: skillName,
          description: plugin.description ?? "",
          source: "claude-marketplace",
          identifier,
          trustLevel: trusted ? "trusted" : "community",
          repo,
          path: skillDir,
          tags: Array.isArray(plugin.tags)
            ? plugin.tags.filter((x): x is string => typeof x === "string")
            : [],
          extra: plugin.name ? { plugin: plugin.name } : {},
        });
        // Cap per-plugin enumeration; some plugins (anthropics/plugin-dev)
        // ship many skills and we don't want one plugin to swamp results.
        if (out.length >= 500) break;
      }
      if (out.length >= 500) break;
    }

    this.cache.write(cacheKey, out);
    return out;
  }

  private async loadManifest(
    repo: string,
    signal?: AbortSignal
  ): Promise<MarketplaceJson | null> {
    const url = `${API_BASE}/repos/${repo}/contents/.claude-plugin/marketplace.json`;
    try {
      const res = await fetch(url, {
        headers: this.auth.headers({ Accept: "application/vnd.github.v3.raw" }),
        signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as MarketplaceJson;
    } catch {
      return null;
    }
  }

  private async loadTree(
    repo: string,
    signal?: AbortSignal
  ): Promise<TreeEntry[] | null> {
    const cacheKey = `gh-tree:${repo}:`;
    const cached = this.cache.read<TreeEntry[]>(cacheKey);
    if (cached) return cached;

    const [owner, name] = repo.split("/");
    if (!owner || !name) return null;
    try {
      const repoRes = await fetch(`${API_BASE}/repos/${repo}`, {
        headers: this.auth.headers(),
        signal,
      });
      if (!repoRes.ok) return null;
      const branch = (await repoRes.json() as { default_branch?: string })
        .default_branch ?? "main";
      const treeRes = await fetch(
        `${API_BASE}/repos/${repo}/git/trees/${branch}?recursive=1`,
        { headers: this.auth.headers(), signal }
      );
      if (!treeRes.ok) return null;
      const body = (await treeRes.json()) as { tree?: TreeEntry[] };
      const tree = body.tree ?? [];
      this.cache.write(cacheKey, tree);
      return tree;
    } catch {
      return null;
    }
  }

  /**
   * `source: "./plugins/foo"` → "plugins/foo"
   * `source: "owner/repo/plugins/foo"` → "plugins/foo" (only if owner/repo matches)
   * `source: { repo, path }` → "<path>" when repo matches, else null
   * `source: { path }` → "<path>"
   */
  private pluginPath(repo: string, source: unknown): string | null {
    if (typeof source === "string") {
      if (source.startsWith("./")) return source.slice(2).replace(/\/+$/, "");
      const stripped = source.replace(/^\/+|\/+$/g, "");
      if (stripped.startsWith(repo + "/")) {
        return stripped.slice(repo.length + 1);
      }
      // Bare path
      if (!stripped.includes(":")) return stripped;
      return null;
    }
    if (source && typeof source === "object") {
      const obj = source as { repo?: string; path?: string };
      if (obj.repo && obj.repo !== repo) return null;
      if (obj.path) return obj.path.replace(/^\.\/?/, "").replace(/\/+$/, "");
    }
    return null;
  }
}
