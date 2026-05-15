import type {
  SkillBundle,
  SkillBundleFile,
  SkillMeta,
  SkillSource,
  Tap,
  TrustLevel,
} from "../types.js";
import type { IndexCache } from "../index-cache.js";
import { sha256OfBundle } from "../content-hash.js";
import { validateBundlePath } from "../path-validation.js";

const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;

interface WellKnownIndex {
  base_url?: string;
  skills?: Array<{
    name?: string;
    description?: string;
    tags?: string[];
    files?: string[];
  }>;
}

/**
 * RFC-style well-known catalog. Hosts publish
 * `<base>/.well-known/skills/index.json` describing each skill plus its
 * relative file list. SKILL.md is implied if not declared.
 *
 * Identifier shape: `well-known:<baseUrl>#<skillName>`
 *
 * Anonymous fetches over HTTPS — the catalog operator is the trust boundary.
 * Tap-driven for search; direct identifier works for inspect/fetch.
 */
export class WellKnownSource implements SkillSource {
  readonly id = "well-known" as const;

  constructor(
    private readonly cache: IndexCache,
    private readonly taps: () => Tap[]
  ) {}

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
    for (const tap of this.taps().filter((t) => t.source === "well-known")) {
      try {
        const idx = await this.loadIndex(tap.repo, opts.signal);
        if (!idx) continue;
        for (const skill of idx.skills ?? []) {
          if (out.length >= limit) return out;
          const name = (skill.name ?? "").trim();
          if (!name) continue;
          const description = skill.description ?? "";
          const tags = Array.isArray(skill.tags)
            ? skill.tags.filter((x): x is string => typeof x === "string")
            : [];
          if (
            q &&
            !name.toLowerCase().includes(q) &&
            !description.toLowerCase().includes(q) &&
            !tags.some((t) => t.toLowerCase().includes(q))
          ) {
            continue;
          }
          out.push({
            name,
            description,
            source: "well-known",
            identifier: `well-known:${tap.repo}#${name}`,
            trustLevel: "community",
            repo: tap.repo,
            path: name,
            tags,
            extra: { files: skill.files ?? [] },
          });
        }
      } catch {
        // best-effort
      }
    }
    return out;
  }

  async inspect(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillMeta | null> {
    const parsed = this.parseIdentifier(identifier);
    if (!parsed) return null;
    const idx = await this.loadIndex(parsed.base, opts.signal);
    if (!idx) return null;
    const entry = (idx.skills ?? []).find(
      (s) => (s.name ?? "").trim() === parsed.name
    );
    if (!entry) return null;
    return {
      name: parsed.name,
      description: entry.description ?? "",
      source: "well-known",
      identifier,
      trustLevel: "community",
      repo: parsed.base,
      path: parsed.name,
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((x): x is string => typeof x === "string")
        : [],
      extra: { files: entry.files ?? [] },
    };
  }

  async fetch(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillBundle | null> {
    const parsed = this.parseIdentifier(identifier);
    if (!parsed) return null;
    const idx = await this.loadIndex(parsed.base, opts.signal);
    if (!idx) return null;
    const entry = (idx.skills ?? []).find(
      (s) => (s.name ?? "").trim() === parsed.name
    );
    if (!entry) return null;

    const fileList = Array.isArray(entry.files) && entry.files.length > 0
      ? entry.files
      : ["SKILL.md"];

    const files: SkillBundleFile[] = [];
    let total = 0;
    for (const rel of fileList) {
      if (files.length >= MAX_FILES) break;
      try {
        validateBundlePath(rel);
      } catch {
        continue;
      }
      const url = `${parsed.base.replace(/\/+$/, "")}/${encodeURI(parsed.name)}/${encodeURI(rel)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "openacme-skills-hub" },
        signal: opts.signal,
      });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) {
        throw new Error(`bundle exceeds ${MAX_TOTAL_BYTES} bytes`);
      }
      files.push({ relPath: rel, bytes });
    }

    if (!files.some((f) => f.relPath === "SKILL.md")) return null;
    return {
      name: parsed.name,
      files,
      source: "well-known",
      sourceIdentifier: identifier,
      resolvedRef: "",
      contentHash: sha256OfBundle(files),
    };
  }

  // -------------------------------------------------------------------------

  private parseIdentifier(
    identifier: string
  ): { base: string; name: string } | null {
    if (!identifier.startsWith("well-known:")) return null;
    const rest = identifier.slice("well-known:".length);
    const hash = rest.lastIndexOf("#");
    if (hash <= 0) return null;
    const base = rest.slice(0, hash).replace(/\/+$/, "");
    const name = rest.slice(hash + 1).trim();
    if (!/^https?:\/\//i.test(base) || !name) return null;
    return { base, name };
  }

  private async loadIndex(
    base: string,
    signal?: AbortSignal
  ): Promise<WellKnownIndex | null> {
    const cacheKey = `well-known:${base}`;
    const cached = this.cache.read<WellKnownIndex>(cacheKey);
    if (cached) return cached;
    const url = `${base.replace(/\/+$/, "")}/.well-known/skills/index.json`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "openacme-skills-hub" },
        signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as WellKnownIndex;
      this.cache.write(cacheKey, json);
      return json;
    } catch {
      return null;
    }
  }
}
