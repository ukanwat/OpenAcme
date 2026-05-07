import matter from "gray-matter";
import type { Skill, SkillFrontmatter } from "./types.js";
import { SkillFrontmatterSchema } from "./types.js";

/**
 * Parse a SKILL.md file into a Skill object.
 *
 * Format (from Hermes):
 * ```markdown
 * ---
 * name: test-driven-development
 * description: "TDD workflow"
 * version: 1.0.0
 * metadata:
 *   hermes:
 *     tags: [testing, tdd]
 *     related_skills: [systematic-debugging]
 * ---
 *
 * # Test-Driven Development
 * ## When to Use
 * ...
 * ```
 */
export function parseSkillFile(
  content: string,
  filePath: string,
  fallbackName: string
): Skill {
  const { data, content: body } = matter(content);

  // Validate frontmatter with Zod schema
  const parseResult = SkillFrontmatterSchema.safeParse(data);
  if (!parseResult.success) {
    console.warn(
      `Invalid frontmatter in ${filePath}: ${parseResult.error.message}`
    );
  }

  const fm = data as Partial<SkillFrontmatter>;

  const name = fm.name ?? fallbackName;
  const description = fm.description ?? extractFirstParagraph(body);
  const tags = fm.metadata?.hermes?.tags ?? [];
  const relatedSkills = fm.metadata?.hermes?.related_skills ?? [];

  return {
    name,
    description,
    tags,
    relatedSkills,
    body: body.trim(),
    filePath,
    frontmatter: {
      name,
      description,
      ...fm,
    },
  };
}

/**
 * Extract the first non-heading paragraph from markdown as a fallback description.
 */
function extractFirstParagraph(markdown: string): string {
  const lines = markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("```")) {
      return trimmed.slice(0, 200);
    }
  }
  return "";
}
