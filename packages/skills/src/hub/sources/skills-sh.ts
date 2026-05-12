import type {
  SkillBundle,
  SkillMeta,
  SkillSource,
  TrustLevel,
} from "../types.js";
import type { IndexCache } from "../index-cache.js";
import type { GitHubAuth } from "../github-auth.js";
import type { GitHubSource } from "./github.js";

const API_BASE = "https://skills.sh/api";
const GH_API = "https://api.github.com";
const TRUSTED_REPOS = new Set<string>(["anthropics/skills"]);

interface SearchHit {
  id?: string;
  source?: string;
  skillId?: string;
  name?: string;
  description?: string;
  tags?: string[];
  installs?: number;
}

/**
 * skills.sh source. We use only the structured JSON `/api/search` endpoint
 * to discover skills, then delegate inspect + fetch to GitHubSource using
 * the `<org>/<repo>/<skillId>` shape skills.sh advertises in its hits.
 *
 * Hermes additionally scrapes detail-page HTML for weekly-installs and
 * security-audit badges. We don't — the JSON gives us name/description/
 * tags/install-count, and the detail HTML is fragile to UI changes.
 */
export class SkillsShSource implements SkillSource {
  readonly id = "skills-sh" as const;

  constructor(
    private readonly github: GitHubSource,
    private readonly cache: IndexCache,
    private readonly auth: GitHubAuth
  ) {}

  trustLevelFor(identifier: string): TrustLevel {
    const parts = identifier.split("/");
    if (parts.length < 2) return "community";
    const repo = `${parts[0]}/${parts[1]}`;
    return TRUSTED_REPOS.has(repo) ? "trusted" : "community";
  }

  async search(
    query: string,
    opts: { limit?: number; signal?: AbortSignal } = {}
  ): Promise<SkillMeta[]> {
    const limit = opts.limit ?? 25;
    const q = query.trim();
    // skills.sh's /api/search rejects queries shorter than 2 chars and
    // exposes no "list all" / "trending" endpoint, so an empty Browse
    // tab on this source is just blank by design. Short-circuit instead
    // of generating a useless network error.
    if (q.length < 2) return [];
    const cacheKey = `skills-sh:search:${q}:${limit}`;
    const cached = this.cache.read<SearchHit[]>(cacheKey);
    const hits = cached ?? (await this.callSearch(q, limit, opts.signal));
    if (!cached && hits.length > 0) this.cache.write(cacheKey, hits);

    const out: SkillMeta[] = [];
    for (const hit of hits) {
      if (out.length >= limit) break;
      const identifier = hit.id ?? this.composeIdentifier(hit);
      if (!identifier) continue;
      const name = hit.name ?? identifier.split("/").pop() ?? "";
      if (!name) continue;
      out.push({
        name,
        description: hit.description ?? "",
        source: "skills-sh",
        identifier,
        trustLevel: this.trustLevelFor(identifier),
        repo: this.repoOf(identifier),
        path: this.pathOf(identifier),
        tags: Array.isArray(hit.tags)
          ? hit.tags.filter((x): x is string => typeof x === "string")
          : [],
        extra: typeof hit.installs === "number" ? { installs: hit.installs } : {},
      });
    }
    return out;
  }

  async inspect(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillMeta | null> {
    if (!this.canHandle(identifier)) return null;
    const resolved = await this.resolveGithubId(identifier, opts.signal);
    if (!resolved) return null;
    const meta = await this.github.inspect(resolved, opts);
    if (!meta) return null;
    return { ...meta, source: "skills-sh" };
  }

  async fetch(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillBundle | null> {
    if (!this.canHandle(identifier)) return null;
    const resolved = await this.resolveGithubId(identifier, opts.signal);
    if (!resolved) return null;
    const bundle = await this.github.fetch(resolved, opts);
    if (!bundle) return null;
    return { ...bundle, source: "skills-sh" };
  }

  /**
   * skills.sh's `id` field is logical (`<repo>/<skillId>`); the actual
   * GitHub path is usually `<repo>/skills/<skillId>` or similar. Try the
   * literal identifier first; on miss, walk the repo's git tree once to
   * find any path ending in `<skillId>/SKILL.md` and use that. Cached.
   */
  private async resolveGithubId(
    identifier: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const cacheKey = `skills-sh:resolve:${identifier}`;
    const cached = this.cache.read<string | null>(cacheKey);
    if (cached !== null && cached !== undefined) return cached;

    // First try the literal identifier — works for repos with skills at root.
    const direct = await this.github.inspect(identifier, { signal });
    if (direct) {
      this.cache.write(cacheKey, identifier);
      return identifier;
    }

    // Otherwise walk the tree.
    const repo = this.repoOf(identifier);
    const slug = this.pathOf(identifier);
    if (!repo || !slug) return null;
    const path = await this.findSkillPathInRepo(repo, slug, signal);
    if (!path) {
      this.cache.write(cacheKey, null);
      return null;
    }
    const resolved = `${repo}/${path}`;
    this.cache.write(cacheKey, resolved);
    return resolved;
  }

  private async findSkillPathInRepo(
    repo: string,
    skillSlug: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const treeKey = `gh-tree:${repo}:`;
    let tree = this.cache.read<Array<{ path: string; type: string }>>(treeKey);
    if (!tree) {
      try {
        const r1 = await fetch(`${GH_API}/repos/${repo}`, {
          headers: this.auth.headers(),
          signal,
        });
        if (!r1.ok) return null;
        const branch = (await r1.json() as { default_branch?: string })
          .default_branch ?? "main";
        const r2 = await fetch(
          `${GH_API}/repos/${repo}/git/trees/${branch}?recursive=1`,
          { headers: this.auth.headers(), signal }
        );
        if (!r2.ok) return null;
        const body = (await r2.json()) as { tree?: Array<{ path: string; type: string }> };
        tree = body.tree ?? [];
        this.cache.write(treeKey, tree);
      } catch {
        return null;
      }
    }
    const candidate = tree.find(
      (e) => e.type === "blob" && e.path.endsWith(`/${skillSlug}/SKILL.md`)
    );
    if (!candidate) return null;
    return candidate.path.slice(0, -"/SKILL.md".length);
  }

  // -------------------------------------------------------------------------

  private canHandle(identifier: string): boolean {
    return identifier.split("/").length >= 2 && !identifier.includes(":");
  }

  private composeIdentifier(hit: SearchHit): string | null {
    if (hit.source && hit.skillId) {
      const sep = hit.source.endsWith("/") ? "" : "/";
      return `${hit.source}${sep}${hit.skillId}`.replace(/^\/+|\/+$/g, "");
    }
    return null;
  }

  private repoOf(id: string): string | undefined {
    const parts = id.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  }

  private pathOf(id: string): string | undefined {
    const parts = id.split("/");
    return parts.length >= 3 ? parts.slice(2).join("/") : undefined;
  }

  private async callSearch(
    query: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<SearchHit[]> {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    params.set("limit", String(limit));
    const url = `${API_BASE}/search?${params.toString()}`;
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "openacme-skills-hub",
        },
        signal,
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { skills?: SearchHit[] } | SearchHit[];
      return Array.isArray(json) ? json : json.skills ?? [];
    } catch {
      return [];
    }
  }
}
