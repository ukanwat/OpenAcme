import type {
  SkillBundle,
  SkillMeta,
  SkillSource,
  TrustLevel,
} from "../types.js";
import type { IndexCache } from "../index-cache.js";
import { sha256OfBundle } from "../content-hash.js";
import { extractZipBundle } from "./zip.js";

const API_BASE = "https://clawhub.ai/api/v1";

interface ClawSkillEntry {
  slug?: string;
  displayName?: string;
  name?: string;
  summary?: string;
  description?: string;
  tags?: string[] | Record<string, unknown>;
  latestVersion?: string;
}

/**
 * ClawHub source. Public catalog at clawhub.ai. Trust is **hardcoded
 * community** for everything served by this source — Hermes' ClawHavoc
 * incident (Feb-2026) is the reason. Do not introduce a trusted-repo
 * allowlist for clawhub.
 *
 * Bundle delivery is ZIP via `/download`. Extraction enforces size +
 * count caps per-entry to defend against zip bombs.
 */
export class ClawHubSource implements SkillSource {
  readonly id = "clawhub" as const;

  constructor(private readonly cache: IndexCache) {}

  trustLevelFor(): TrustLevel {
    return "community";
  }

  async search(
    query: string,
    opts: { limit?: number; signal?: AbortSignal } = {}
  ): Promise<SkillMeta[]> {
    const q = query.toLowerCase().trim();
    const limit = opts.limit ?? 25;
    const cacheKey = `clawhub:listing:${q || "__all__"}:${limit}`;
    const cached = this.cache.read<ClawSkillEntry[]>(cacheKey);
    const entries = cached ?? (await this.fetchListing(q, limit, opts.signal));
    if (!cached && entries.length > 0) this.cache.write(cacheKey, entries);

    const out: SkillMeta[] = [];
    for (const entry of entries) {
      if (out.length >= limit) break;
      const meta = this.toMeta(entry);
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
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillMeta | null> {
    const slug = this.parseSlug(identifier);
    if (!slug) return null;
    const url = `${API_BASE}/skills/${encodeURIComponent(slug)}`;
    const res = await this.requestWithRetry(url, { signal: opts.signal });
    if (!res || !res.ok) return null;
    const body = (await res.json()) as { skill?: ClawSkillEntry } | ClawSkillEntry;
    const entry = "skill" in body && body.skill ? body.skill : (body as ClawSkillEntry);
    return this.toMeta({ ...entry, slug });
  }

  async fetch(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillBundle | null> {
    const slug = this.parseSlug(identifier);
    if (!slug) return null;
    const version = await this.resolveVersion(slug, opts.signal);
    const url = `${API_BASE}/download?slug=${encodeURIComponent(slug)}${version ? `&version=${encodeURIComponent(version)}` : ""}`;
    const res = await this.requestWithRetry(url, { signal: opts.signal });
    if (!res || !res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    let files;
    try {
      files = extractZipBundle(buf);
    } catch {
      return null;
    }
    if (!files.some((f) => f.relPath === "SKILL.md")) return null;
    return {
      name: slug,
      files,
      source: "clawhub",
      sourceIdentifier: slug,
      resolvedRef: version,
      contentHash: sha256OfBundle(files),
    };
  }

  // -------------------------------------------------------------------------

  private parseSlug(identifier: string): string | null {
    if (!identifier) return null;
    const slug = identifier
      .replace(/^clawhub\//, "")
      .replace(/^\/+|\/+$/g, "");
    if (!slug || slug.includes("/")) return null;
    return slug;
  }

  private toMeta(entry: ClawSkillEntry): SkillMeta | null {
    const slug = entry.slug ?? "";
    if (!slug) return null;
    const name = entry.displayName ?? entry.name ?? slug;
    return {
      name,
      description: entry.summary ?? entry.description ?? "",
      source: "clawhub",
      identifier: slug,
      trustLevel: "community",
      tags: this.normalizeTags(entry.tags),
      extra: entry.latestVersion ? { latestVersion: entry.latestVersion } : {},
    };
  }

  private normalizeTags(tags: ClawSkillEntry["tags"]): string[] {
    if (!tags) return [];
    if (Array.isArray(tags)) {
      return tags.filter((x): x is string => typeof x === "string");
    }
    return Object.keys(tags).filter((k) => k !== "latest");
  }

  private async fetchListing(
    query: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<ClawSkillEntry[]> {
    const params = new URLSearchParams();
    if (query) params.set("search", query);
    params.set("limit", String(limit));
    const url = `${API_BASE}/skills?${params.toString()}`;
    const res = await this.requestWithRetry(url, { signal });
    if (!res || !res.ok) return [];
    const json = (await res.json()) as {
      items?: ClawSkillEntry[];
      skills?: ClawSkillEntry[];
    };
    return json.items ?? json.skills ?? [];
  }

  private async resolveVersion(
    slug: string,
    signal?: AbortSignal
  ): Promise<string> {
    const url = `${API_BASE}/skills/${encodeURIComponent(slug)}`;
    const res = await this.requestWithRetry(url, { signal });
    if (!res || !res.ok) return "";
    const body = (await res.json()) as { latestVersion?: string; skill?: ClawSkillEntry };
    return body.latestVersion ?? body.skill?.latestVersion ?? "";
  }

  /**
   * GET with 429 retry-after handling. Caps at 3 attempts; sleeps capped
   * at 15s as Hermes does.
   */
  private async requestWithRetry(
    url: string,
    opts: { signal?: AbortSignal }
  ): Promise<Response | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { "User-Agent": "openacme-skills-hub" },
          signal: opts.signal,
        });
      } catch {
        return null;
      }
      if (res.status !== 429) return res;
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      const delaySec = Math.min(Number.isFinite(retryAfter) ? retryAfter : 1, 15);
      await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
    }
    return null;
  }
}
