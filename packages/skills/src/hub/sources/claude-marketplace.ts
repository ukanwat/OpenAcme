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

interface MarketplaceJson {
  plugins?: Array<{
    name?: string;
    description?: string;
    source?: string | { source?: string; repo?: string; path?: string };
    tags?: string[];
  }>;
}

/**
 * Reads `.claude-plugin/marketplace.json` at a repo root and exposes
 * each plugin entry as a SkillMeta. Delegates inspect()/fetch() to a
 * wrapped GitHubSource, rewriting `source` on the way out so the
 * lockfile records the install came via the marketplace pathway.
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
        const entries = await this.loadMarketplace(tap.repo, opts.signal);
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

  private async loadMarketplace(
    repo: string,
    signal?: AbortSignal
  ): Promise<SkillMeta[]> {
    const cacheKey = `claude-marketplace:${repo}`;
    const cached = this.cache.read<SkillMeta[]>(cacheKey);
    if (cached) return cached;

    const url = `${API_BASE}/repos/${repo}/contents/.claude-plugin/marketplace.json`;
    const res = await fetch(url, {
      headers: this.auth.headers({ Accept: "application/vnd.github.v3.raw" }),
      signal,
    });
    if (!res.ok) {
      this.cache.write(cacheKey, []);
      return [];
    }
    const raw = (await res.json()) as MarketplaceJson;
    const trusted = TRUSTED_REPOS.has(repo);
    const out: SkillMeta[] = [];
    for (const p of raw.plugins ?? []) {
      const id = this.resolveSource(repo, p.source);
      const name = p.name ?? id.split("/").pop() ?? "";
      if (!name) continue;
      out.push({
        name,
        description: p.description ?? "",
        source: "claude-marketplace",
        identifier: id,
        trustLevel: trusted ? "trusted" : "community",
        repo,
        path: id.startsWith(repo + "/") ? id.slice(repo.length + 1) : undefined,
        tags: Array.isArray(p.tags) ? p.tags.filter((x): x is string => typeof x === "string") : [],
        extra: {},
      });
    }
    this.cache.write(cacheKey, out);
    return out;
  }

  /**
   * `source: "./path"` → "<marketplaceRepo>/path"
   * `source: { repo, path }` → "<repo>/<path>"
   * `source: "owner/repo/path"` → as-is
   */
  private resolveSource(marketplaceRepo: string, source: unknown): string {
    if (typeof source === "string") {
      if (source.startsWith("./")) {
        return `${marketplaceRepo}/${source.slice(2)}`;
      }
      if (source.includes("/")) return source.replace(/^\/+|\/+$/g, "");
    }
    if (source && typeof source === "object") {
      const obj = source as { repo?: string; path?: string };
      if (obj.repo) {
        return obj.path ? `${obj.repo}/${obj.path}` : obj.repo;
      }
      if (obj.path) {
        return `${marketplaceRepo}/${obj.path}`;
      }
    }
    return marketplaceRepo;
  }
}
