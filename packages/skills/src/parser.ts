import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { createLogger } from "@openacme/config/logger";
import type { Skill, SkillFrontmatter, SkillResource } from "./types.js";
import { SkillFrontmatterSchema } from "./types.js";

const log = createLogger("skills.parser");

const MAX_RESOURCES_PER_SKILL = 200;

/**
 * Parse a SKILL.md file's text into a Skill object.
 * Companion-file discovery is layered on top by parseSkillDirectory.
 */
export function parseSkillFile(
  content: string,
  filePath: string,
  fallbackName: string
): Skill {
  const { data, content: body } = matter(content);

  const parseResult = SkillFrontmatterSchema.safeParse(data);
  if (!parseResult.success) {
    log.warn(
      { filePath, err: parseResult.error.message },
      "invalid skill frontmatter"
    );
  }

  const fm = data as Partial<SkillFrontmatter>;

  const name = fm.name ?? fallbackName;
  const description = fm.description ?? extractFirstParagraph(body);

  // Top-level fields win; fall back to legacy metadata.hermes.* for
  // skills authored against the old shape.
  const tags = fm.tags ?? fm.metadata?.hermes?.tags ?? [];
  const relatedSkills =
    fm["related-skills"] ?? fm.metadata?.hermes?.related_skills ?? [];

  return {
    name,
    description,
    tags,
    relatedSkills,
    body: body.trim(),
    filePath,
    dirPath: path.dirname(filePath),
    resources: [],
    frontmatter: { name, description, ...fm },
  };
}

/**
 * Parse SKILL.md and discover its sibling files. The skill directory is
 * walked (recursively, depth-first) and every regular file other than
 * SKILL.md itself is recorded as a resource. Contents are NOT read.
 */
export function parseSkillDirectory(
  filePath: string,
  fallbackName: string
): Skill {
  const realPath = fs.realpathSync(filePath);
  const content = fs.readFileSync(realPath, "utf-8");
  const skill = parseSkillFile(content, realPath, fallbackName);
  skill.resources = discoverResources(skill.dirPath);
  return skill;
}

function discoverResources(dirPath: string): SkillResource[] {
  const out: SkillResource[] = [];
  walk(dirPath, dirPath, out);
  return out;
}

function walk(rootDir: string, currentDir: string, out: SkillResource[]): void {
  if (out.length >= MAX_RESOURCES_PER_SKILL) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_RESOURCES_PER_SKILL) return;
    if (entry.name.startsWith(".")) continue;

    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(rootDir, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (currentDir === rootDir && entry.name === "SKILL.md") continue;

    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }

    const rel = path.relative(rootDir, full).split(path.sep).join("/");
    out.push({ path: full, relPath: rel, size });
  }
}

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
