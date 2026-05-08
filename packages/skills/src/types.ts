/**
 * Skill types — Anthropic Agent Skills open-standard frontmatter, with
 * back-compat for the legacy hermes-namespaced layout.
 *
 * Canonical (preferred) shape:
 *   ---
 *   name: my-skill              # kebab-case, ≤64 chars
 *   description: "..."          # ≤1024 chars
 *   license: MIT                # optional
 *   tags: [a, b]                # optional, top-level
 *   related-skills: [other]     # optional, top-level
 *   ---
 *
 * Legacy (still read) shape:
 *   metadata:
 *     hermes:
 *       tags: [...]
 *       related_skills: [...]
 */
import { z } from "zod";

const KebabName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "name must be kebab-case");

export const SkillFrontmatterSchema = z
  .object({
    name: KebabName.optional(),
    description: z.string().max(1024).optional(),
    license: z.string().max(100).optional(),
    version: z.string().max(50).optional(),
    author: z.string().max(200).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
    "related-skills": z.array(z.string().max(64)).max(20).optional(),
    metadata: z
      .object({
        hermes: z
          .object({
            tags: z.array(z.string().max(50)).max(20).optional(),
            related_skills: z.array(z.string().max(64)).max(20).optional(),
          })
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  version?: string;
  author?: string;
  tags?: string[];
  "related-skills"?: string[];
  metadata?: {
    hermes?: {
      tags?: string[];
      related_skills?: string[];
    };
    [key: string]: unknown;
  };
}

/**
 * A companion file living next to SKILL.md in the skill directory.
 * Discovered at load time; contents are NOT read until the agent asks.
 */
export interface SkillResource {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the skill directory (POSIX-style). */
  relPath: string;
  /** Size in bytes. */
  size: number;
}

/**
 * Full parsed skill — loaded from a SKILL.md file.
 */
export interface Skill {
  /** Unique name (from frontmatter or directory name). */
  name: string;
  /** Short description. */
  description: string;
  /** Tags for search. */
  tags: string[];
  /** Related skill names. */
  relatedSkills: string[];
  /** Full markdown body (without frontmatter). */
  body: string;
  /** Absolute path to SKILL.md. */
  filePath: string;
  /** Absolute path to the directory containing SKILL.md. */
  dirPath: string;
  /** Sibling files in the skill directory (excluding SKILL.md). */
  resources: SkillResource[];
  /** Raw frontmatter. */
  frontmatter: SkillFrontmatter;
}

/**
 * Level-0 index entry — name + description + tags only.
 * Injected into system prompts so the agent knows what skills exist.
 */
export interface SkillIndexEntry {
  name: string;
  description: string;
  tags: string[];
}
