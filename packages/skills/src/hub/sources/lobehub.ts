import type {
  SkillBundle,
  SkillBundleFile,
  SkillMeta,
  SkillSource,
  TrustLevel,
} from "../types.js";
import type { IndexCache } from "../index-cache.js";
import { sha256OfBundle } from "../content-hash.js";
import { safeName } from "../path-validation.js";

const INDEX_URL = "https://chat-agents.lobehub.com/index.json";

interface LobeAgent {
  identifier?: string;
  meta?: { title?: string; description?: string; tags?: string[] };
  config?: { systemRole?: string };
}

/**
 * LobeHub source. LobeHub publishes ~14k system-prompt templates as JSON.
 * The catalog itself isn't "skills" in the OpenAcme sense — we synthesize
 * a single-file SKILL.md from each agent's `systemRole` so users can adopt
 * a LobeHub prompt as a skill.
 *
 * Identifier shape: `lobehub/<agent_id>`. Anonymous fetches. Trust is
 * always community — these are user-submitted prompts.
 */
export class LobeHubSource implements SkillSource {
  readonly id = "lobehub" as const;

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
    const agents = await this.loadIndex(opts.signal);
    const out: SkillMeta[] = [];
    for (const agent of agents) {
      if (out.length >= limit) break;
      const meta = this.toMeta(agent);
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
    const id = this.parseIdentifier(identifier);
    if (!id) return null;
    const agents = await this.loadIndex(opts.signal);
    const agent = agents.find((a) => this.agentId(a) === id);
    if (!agent) return null;
    return this.toMeta(agent);
  }

  async fetch(
    identifier: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<SkillBundle | null> {
    const id = this.parseIdentifier(identifier);
    if (!id) return null;
    const agents = await this.loadIndex(opts.signal);
    const agent = agents.find((a) => this.agentId(a) === id);
    if (!agent) return null;

    const name = safeName(this.agentId(agent));
    const description = agent.meta?.description ?? "";
    const tags = Array.isArray(agent.meta?.tags)
      ? agent.meta!.tags!.filter((x): x is string => typeof x === "string")
      : [];
    const systemRole = agent.config?.systemRole ?? "(No system role defined)";
    const skillMd = this.renderSkillMd({ name, description, tags, systemRole, agent });

    const files: SkillBundleFile[] = [
      { relPath: "SKILL.md", bytes: new TextEncoder().encode(skillMd) },
    ];

    return {
      name,
      files,
      source: "lobehub",
      sourceIdentifier: identifier,
      resolvedRef: "",
      contentHash: sha256OfBundle(files),
    };
  }

  // -------------------------------------------------------------------------

  private parseIdentifier(identifier: string): string | null {
    if (!identifier.startsWith("lobehub/")) return null;
    const id = identifier.slice("lobehub/".length).trim();
    return id || null;
  }

  private agentId(agent: LobeAgent): string {
    if (typeof agent.identifier === "string" && agent.identifier.trim()) {
      return agent.identifier.trim();
    }
    const title = agent.meta?.title ?? "";
    return title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  }

  private toMeta(agent: LobeAgent): SkillMeta | null {
    const id = this.agentId(agent);
    if (!id) return null;
    const safe = safeName(id);
    if (!safe) return null;
    const tags = Array.isArray(agent.meta?.tags)
      ? agent.meta!.tags!.filter((x): x is string => typeof x === "string")
      : [];
    const title = agent.meta?.title?.trim();
    // `name` is the canonical kebab-case form fetch() will install under
    // — keep it aligned so the install button's already-installed check
    // matches what lands in the lockfile. Title goes in description so
    // cards still read well.
    const description = title && title !== safe
      ? `${title}${agent.meta?.description ? ` — ${agent.meta.description}` : ""}`
      : agent.meta?.description ?? "";
    return {
      name: safe,
      description,
      source: "lobehub",
      identifier: `lobehub/${id}`,
      trustLevel: "community",
      tags,
      extra: title ? { title } : {},
    };
  }

  private async loadIndex(signal?: AbortSignal): Promise<LobeAgent[]> {
    const cacheKey = "lobehub:index";
    const cached = this.cache.read<LobeAgent[]>(cacheKey);
    if (cached) return cached;
    try {
      const res = await fetch(INDEX_URL, {
        headers: { "User-Agent": "openacme-skills-hub" },
        signal,
      });
      if (!res.ok) return [];
      const raw = (await res.json()) as { agents?: LobeAgent[] } | LobeAgent[];
      const agents = Array.isArray(raw) ? raw : raw.agents ?? [];
      this.cache.write(cacheKey, agents);
      return agents;
    } catch {
      return [];
    }
  }

  private renderSkillMd(args: {
    name: string;
    description: string;
    tags: string[];
    systemRole: string;
    agent: LobeAgent;
  }): string {
    const fmTags = args.tags.length > 0
      ? `\ntags:\n${args.tags.map((t) => `  - ${this.yamlString(t)}`).join("\n")}`
      : "";
    const title = args.agent.meta?.title ?? args.name;
    return [
      "---",
      `name: ${this.yamlString(args.name)}`,
      `description: ${this.yamlString(args.description || title)}${fmTags}`,
      "---",
      "",
      `# ${title}`,
      "",
      args.description || "",
      "",
      "## Instructions",
      "",
      args.systemRole,
      "",
    ].join("\n");
  }

  private yamlString(s: string): string {
    if (/^[A-Za-z0-9 _.\-,/]+$/.test(s) && !s.includes(": ")) return s;
    return JSON.stringify(s);
  }
}
