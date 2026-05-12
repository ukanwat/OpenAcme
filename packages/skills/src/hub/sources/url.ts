import matter from "gray-matter";
import type {
  SkillBundle,
  SkillMeta,
  SkillSource,
  TrustLevel,
} from "../types.js";
import { safeName } from "../path-validation.js";
import { sha256OfBundle } from "../content-hash.js";

/**
 * Direct URL source. Identifier is the URL itself.
 *
 * v1 supports a single SKILL.md fetch — companion-file URL bundles
 * would require shipping a manifest format we don't have. If you want
 * companion files, host the skill on GitHub and use GitHubSource.
 */
export class UrlSource implements SkillSource {
  readonly id = "url" as const;

  trustLevelFor(): TrustLevel {
    return "community";
  }

  async search(): Promise<SkillMeta[]> {
    // Direct URLs aren't a searchable space; install requires the
    // exact identifier.
    return [];
  }

  async inspect(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillMeta | null> {
    if (!/^https?:\/\//i.test(identifier)) return null;
    const text = await this.fetchText(identifier, opts.signal);
    if (text === null) return null;
    const { data } = matter(text);
    const fm = data as Record<string, unknown>;
    const name = this.deriveName(identifier, fm);
    if (!name) return null;
    return {
      name,
      description:
        typeof fm["description"] === "string" ? fm["description"] : "",
      source: "url",
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
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillBundle | null> {
    if (!/^https?:\/\//i.test(identifier)) return null;
    const text = await this.fetchText(identifier, opts.signal);
    if (text === null) return null;
    const { data } = matter(text);
    const fm = data as Record<string, unknown>;
    const name = this.deriveName(identifier, fm);
    if (!name) return null;

    const bytes = new TextEncoder().encode(text);
    const files = [{ relPath: "SKILL.md", bytes }];
    return {
      name,
      files,
      source: "url",
      sourceIdentifier: identifier,
      resolvedRef: "",
      contentHash: sha256OfBundle(files),
    };
  }

  private async fetchText(
    url: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "openacme-skills-hub" },
        signal,
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  private deriveName(url: string, fm: Record<string, unknown>): string {
    if (typeof fm["name"] === "string" && fm["name"]) {
      return safeName(fm["name"]);
    }
    // .../<name>/SKILL.md → <name>
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      if (parts[parts.length - 1] === "SKILL.md" && parts.length >= 2) {
        return safeName(parts[parts.length - 2]!);
      }
      // .../<name>.md → <name>
      const tail = parts[parts.length - 1] ?? "";
      if (tail.endsWith(".md")) {
        return safeName(tail.slice(0, -3));
      }
    } catch {
      // bad URL
    }
    return "";
  }
}
