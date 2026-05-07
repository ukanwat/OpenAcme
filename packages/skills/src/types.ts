/**
 * Skill types — mirrors Hermes skill file format.
 *
 * Skills use SKILL.md files with YAML frontmatter.
 */
import { z } from "zod";

/**
 * Zod schema for skill frontmatter validation.
 */
export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  version: z.string().max(50).optional(),
  author: z.string().max(200).optional(),
  license: z.string().max(100).optional(),
  metadata: z.object({
    hermes: z.object({
      tags: z.array(z.string().max(50)).max(20).optional(),
      related_skills: z.array(z.string().max(100)).max(20).optional(),
    }).optional(),
  }).passthrough().optional(),
}).passthrough();

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
  metadata?: {
    hermes?: {
      tags?: string[];
      related_skills?: string[];
    };
    [key: string]: unknown;
  };
}

/**
 * Full parsed skill — loaded from a SKILL.md file.
 */
export interface Skill {
  /** Unique name (from frontmatter or directory name) */
  name: string;
  /** Short description */
  description: string;
  /** Tags for search */
  tags: string[];
  /** Related skill names */
  relatedSkills: string[];
  /** Full markdown body (without frontmatter) */
  body: string;
  /** File path the skill was loaded from */
  filePath: string;
  /** Raw frontmatter */
  frontmatter: SkillFrontmatter;
}

/**
 * Level-0 index entry — name + description + tags only.
 * Injected into system prompts to let the agent know what skills exist.
 */
export interface SkillIndexEntry {
  name: string;
  description: string;
  tags: string[];
}
