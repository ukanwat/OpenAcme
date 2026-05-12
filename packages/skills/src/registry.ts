import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { parseSkillDirectory } from "./parser.js";
import type { Skill, SkillIndexEntry } from "./types.js";

// Maximum skill file size: 1MB
const MAX_SKILL_FILE_SIZE = 1024 * 1024;

/**
 * SkillRegistry — loads skills from directories, provides progressive disclosure.
 *
 * Progressive disclosure levels (from Hermes skill_utils.py):
 * - Level 0: Index only — name + description + tags (for system prompt)
 * - Level 1: Full skill content (when agent activates a skill)
 * - Level 2: Related skills loaded on demand
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();

  /**
   * Load all SKILL.md files from a directory (recursive).
   * Supports both flat and nested structures:
   *   skills/my-skill/SKILL.md
   *   skills/category/my-skill/SKILL.md
   *
   * Reloads from scratch — clears previously loaded entries first so a
   * deleted skill (rm'd between calls) drops out of the in-memory index.
   */
  loadFromDirectory(dir: string): void {
    this.skills.clear();
    if (!fs.existsSync(dir)) {
      return;
    }

    this.scanDirectory(dir);
  }

  private scanDirectory(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile() && entry.name === "SKILL.md") {
        this.loadSkillFile(fullPath, dir);
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        this.scanDirectory(fullPath);
      }
    }
  }

  private loadSkillFile(filePath: string, parentDir: string): void {
    try {
      const realPath = fs.realpathSync(filePath);

      const stat = fs.statSync(realPath);
      if (stat.size > MAX_SKILL_FILE_SIZE) {
        console.warn(
          `Skill file too large (${stat.size} bytes): ${filePath}. Max size: ${MAX_SKILL_FILE_SIZE} bytes.`
        );
        return;
      }

      const fallbackName = path.basename(parentDir);
      const skill = parseSkillDirectory(realPath, fallbackName);
      this.skills.set(skill.name, skill);
    } catch (error) {
      console.warn(
        `Failed to load skill from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Level 0 — Get the index of all skills (name + description + tags).
   * Intended for injection into the system prompt.
   */
  getIndex(): SkillIndexEntry[] {
    return [...this.skills.values()].map((s) => ({
      name: s.name,
      description: s.description,
      tags: s.tags,
    }));
  }

  /**
   * Format the skill index as a string for system prompt injection.
   */
  getIndexAsString(): string {
    const entries = this.getIndex();
    if (entries.length === 0) return "";

    return entries
      .map(
        (e) =>
          `- **${e.name}**: ${e.description}${e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : ""}`
      )
      .join("\n");
  }

  /**
   * Level 1 — Get the full skill content by name.
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Search skills by name or tag.
   */
  searchSkills(query: string): SkillIndexEntry[] {
    const q = query.toLowerCase();
    return this.getIndex().filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
    );
  }

  /**
   * Level 2 — Get a skill and its related skills.
   */
  getSkillWithRelated(name: string): {
    skill: Skill;
    related: Skill[];
  } | null {
    const skill = this.skills.get(name);
    if (!skill) return null;

    const related: Skill[] = [];
    for (const relName of skill.relatedSkills) {
      const rel = this.skills.get(relName);
      if (rel) related.push(rel);
    }

    return { skill, related };
  }

  /**
   * Get count of loaded skills.
   */
  get size(): number {
    return this.skills.size;
  }

  /**
   * Get all skill names.
   */
  getSkillNames(): string[] {
    return [...this.skills.keys()].sort();
  }

  /**
   * Save a skill to disk and add to registry.
   * Creates a SKILL.md file in the skills directory.
   */
  saveSkill(
    skillsDir: string,
    name: string,
    description: string,
    tags: string[],
    body: string
  ): Skill {
    const safeName = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const skillDir = path.join(skillsDir, safeName);
    const filePath = path.join(skillDir, "SKILL.md");

    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    // Canonical (top-level) frontmatter — `tags` lives at the top of the
    // YAML, not under `metadata.hermes`.
    const fm: Record<string, unknown> = { name: safeName, description };
    if (tags.length > 0) fm.tags = tags;

    const content = matter.stringify(body, fm);
    fs.writeFileSync(filePath, content, "utf-8");

    const skill = parseSkillDirectory(filePath, safeName);
    this.skills.set(skill.name, skill);

    return skill;
  }

  /**
   * Delete a skill from disk and registry.
   */
  deleteSkill(skillsDir: string, name: string): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;

    // Remove from registry
    this.skills.delete(name);

    // Delete file if it exists
    if (skill.filePath && fs.existsSync(skill.filePath)) {
      const skillDir = path.dirname(skill.filePath);
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    return true;
  }
}
