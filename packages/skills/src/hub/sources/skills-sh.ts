import type {
  SkillBundle,
  SkillMeta,
  SkillSource,
  TrustLevel,
} from "../types.js";
import type { IndexCache } from "../index-cache.js";
import type { GitHubSource } from "./github.js";

const API_BASE = "https://skills.sh/api";
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
    private readonly cache: IndexCache
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
    const cacheKey = `skills-sh:search:${q || "__featured__"}:${limit}`;
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
    const meta = await this.github.inspect(identifier, opts);
    if (!meta) return null;
    return { ...meta, source: "skills-sh" };
  }

  async fetch(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillBundle | null> {
    if (!this.canHandle(identifier)) return null;
    const bundle = await this.github.fetch(identifier, opts);
    if (!bundle) return null;
    return { ...bundle, source: "skills-sh" };
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
