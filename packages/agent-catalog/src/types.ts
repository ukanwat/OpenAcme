import { z } from "zod";
import {
  MCPServerConfigSchema,
  type AgentDefinition,
  type MCPServerConfig,
} from "@openacme/config";

/**
 * Mirror of `@openacme/skills`' `SkillSourceId`. Duplicated to avoid a
 * cross-package import — skills doesn't export it from its public surface
 * in a way that's stable across `dist`/`src` consumption. Templates
 * reference these by name; the actual install dispatch happens server-side
 * where SkillHub validates against its own list. Keep in sync.
 */
export const SKILL_SOURCE_IDS = [
  "github",
  "url",
  "claude-marketplace",
  "well-known",
  "local",
  "git-url",
  "lobehub",
  "skills-sh",
  "clawhub",
  "builtin",
] as const;
export type SkillSourceId = (typeof SKILL_SOURCE_IDS)[number];

export const RecommendedSkillSchema = z.object({
  name: z.string().min(1).max(64),
  source: z.enum(SKILL_SOURCE_IDS),
  identifier: z.string().min(1).max(512),
});
export type RecommendedSkill = z.infer<typeof RecommendedSkillSchema>;

export const RecommendedMcpServerSchema = z.object({
  name: z.string().min(1).max(64),
  config: MCPServerConfigSchema,
});
export type RecommendedMcpServer = z.infer<typeof RecommendedMcpServerSchema>;

/**
 * Template-only frontmatter keys. Validated separately from the
 * underlying `AgentDefinitionSchema` so an unmaintained AgentDefinition
 * never has to know about them, and stripped before the rest of the
 * frontmatter parses against the agent schema.
 */
export const AgentTemplateMetaFrontmatterSchema = z.object({
  template_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, {
      message: "template_id must be kebab-case (a-z, 0-9, _, -)",
    }),
  template_name: z.string().min(1).max(128),
  template_description: z.string().max(512).default(""),
  template_tags: z.array(z.string().max(32)).default([]),
  default_id_hint: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, {
      message: "default_id_hint must match the agent-id charset",
    }),
  recommended_skills: z.array(RecommendedSkillSchema).default([]),
  recommended_mcp_servers: z.array(RecommendedMcpServerSchema).default([]),
});

export type AgentTemplateMetaFrontmatter = z.infer<
  typeof AgentTemplateMetaFrontmatterSchema
>;

/** A file under a template's `resources/` dir. Mirrors `AgentResource`. */
export interface ResourceFile {
  /** Path relative to `<templateDir>/resources/` (POSIX-style). */
  relPath: string;
  /** Absolute path on disk for copying. */
  absPath: string;
  /** Size in bytes. */
  size: number;
}

/**
 * Summary metadata for the catalog listing UI — cheap enough to return in
 * bulk without persona bodies or full resource lists.
 */
export interface AgentTemplateMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  defaultIdHint: string;
  counts: {
    resources: number;
    skills: number;
    mcpServers: number;
  };
}

/**
 * Full template — meta plus everything an importer needs to materialize a
 * fresh agent folder + install its workforce dependencies.
 */
export interface AgentTemplate {
  meta: AgentTemplateMeta;
  /** AgentDefinition fields (frontmatter + persona body), minus `id`. */
  agentFields: Omit<AgentDefinition, "id">;
  resources: ResourceFile[];
  recommendedSkills: RecommendedSkill[];
  recommendedMcpServers: RecommendedMcpServer[];
}

export type { MCPServerConfig };
