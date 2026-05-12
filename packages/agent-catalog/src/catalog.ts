import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import {
  AgentDefinitionSchema,
  type AgentDefinition,
} from "@openacme/config";
import {
  AgentTemplateMetaFrontmatterSchema,
  type AgentTemplate,
  type AgentTemplateMeta,
  type BundledMcpServer,
  type BundledSkill,
  type ResourceFile,
} from "./types.js";

const AGENT_FILE = "AGENT.md";
const RESOURCES_DIR = "resources";
const MAX_RESOURCES_PER_TEMPLATE = 200;

const TEMPLATE_META_KEYS = new Set([
  "template_id",
  "template_name",
  "template_description",
  "template_tags",
  "default_id_hint",
  "bundled_skills",
  "bundled_mcp_servers",
]);

/**
 * In-memory snapshot of the bundled templates. Read once at construction
 * time; no live reload. Templates change via package upgrade, not at
 * runtime, so the simpler model wins.
 */
export class AgentCatalog {
  private readonly templates = new Map<string, AgentTemplate>();

  constructor(templatesDir?: string) {
    const root = templatesDir ?? defaultTemplatesRoot();
    if (!fs.existsSync(root)) return;
    for (const name of listTemplateDirs(root)) {
      const t = loadTemplate(path.join(root, name));
      if (t) this.templates.set(t.meta.id, t);
    }
  }

  list(): AgentTemplateMeta[] {
    return [...this.templates.values()]
      .map((t) => t.meta)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(templateId: string): AgentTemplate | undefined {
    return this.templates.get(templateId);
  }

  get size(): number {
    return this.templates.size;
  }
}

// -----------------------------------------------------------------------
// Loader
// -----------------------------------------------------------------------

function loadTemplate(templateDir: string): AgentTemplate | null {
  const agentFile = path.join(templateDir, AGENT_FILE);
  if (!fs.existsSync(agentFile)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(agentFile, "utf-8");
  } catch {
    return null;
  }

  const { data, content: body } = matter(raw);
  const fm = data as Record<string, unknown>;

  // Split into template-meta frontmatter and the agent's own frontmatter.
  const metaInput: Record<string, unknown> = {};
  const agentInput: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (TEMPLATE_META_KEYS.has(k)) {
      metaInput[k] = v;
    } else {
      agentInput[k] = v;
    }
  }

  const metaParsed = AgentTemplateMetaFrontmatterSchema.safeParse(metaInput);
  if (!metaParsed.success) {
    console.warn(
      `[agent-catalog] Skipping ${templateDir}: invalid template metadata — ${metaParsed.error.message}`
    );
    return null;
  }

  const personaBody = body.trim();
  const persona =
    personaBody.length > 0
      ? personaBody
      : typeof agentInput["persona"] === "string"
        ? (agentInput["persona"] as string)
        : "";

  // Templates carry no `id` — that's assigned on import. We need an id to
  // satisfy AgentDefinitionSchema during validation; use a sentinel.
  // `buildAgentFromTemplate` swaps it for the real id before any persistence.
  const agentParsed = AgentDefinitionSchema.safeParse({
    ...agentInput,
    persona,
    id: metaParsed.data.default_id_hint,
  });
  if (!agentParsed.success) {
    console.warn(
      `[agent-catalog] Skipping ${templateDir}: invalid agent fields — ${agentParsed.error.message}`
    );
    return null;
  }

  const resources = listResources(templateDir);

  const bundledSkills: BundledSkill[] = metaParsed.data.bundled_skills;
  const bundledMcpServers: BundledMcpServer[] =
    metaParsed.data.bundled_mcp_servers;

  const meta: AgentTemplateMeta = {
    id: metaParsed.data.template_id,
    name: metaParsed.data.template_name,
    description: metaParsed.data.template_description,
    tags: metaParsed.data.template_tags,
    defaultIdHint: metaParsed.data.default_id_hint,
    counts: {
      resources: resources.length,
      skills: bundledSkills.length,
      mcpServers: bundledMcpServers.length,
    },
  };

  // Drop the sentinel id from the AgentDefinition snapshot we hand to
  // importers — `buildAgentFromTemplate` resolves the real id and merges.
  const { id: _ignored, ...agentFields } = agentParsed.data;
  void _ignored;

  return {
    meta,
    agentFields: agentFields as Omit<AgentDefinition, "id">,
    resources,
    bundledSkills,
    bundledMcpServers,
  };
}

function listTemplateDirs(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

function listResources(templateDir: string): ResourceFile[] {
  const resourcesRoot = path.join(templateDir, RESOURCES_DIR);
  if (!fs.existsSync(resourcesRoot)) return [];
  const out: ResourceFile[] = [];
  const walk = (currentDir: string): void => {
    if (out.length >= MAX_RESOURCES_PER_TEMPLATE) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_RESOURCES_PER_TEMPLATE) return;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      const rel = path
        .relative(resourcesRoot, full)
        .split(path.sep)
        .join("/");
      out.push({ relPath: rel, absPath: full, size });
    }
  };
  walk(resourcesRoot);
  return out;
}

function defaultTemplatesRoot(): string {
  // src/catalog.ts → ../templates/
  // dist/catalog.js → ../templates/
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "templates");
}
