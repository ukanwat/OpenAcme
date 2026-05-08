import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";
import { loadConfig } from "@openacme/config";
import { SkillRegistry, parseSkillDirectory } from "@openacme/skills";

export interface SkillsOptions {
  dataDir?: string;
}

interface ResolvedSkillsDir {
  dir: string;
  /** Whether the directory existed before we touched it. */
  existed: boolean;
}

function resolveSkillsDir(opts: SkillsOptions): ResolvedSkillsDir {
  const config = loadConfig(opts.dataDir);
  const dir = path.isAbsolute(config.skills.directory)
    ? config.skills.directory
    : path.join(config.dataDir, config.skills.directory);
  const existed = fs.existsSync(dir);
  if (!existed) fs.mkdirSync(dir, { recursive: true });
  return { dir, existed };
}

function loadRegistry(skillsDir: string): SkillRegistry {
  const reg = new SkillRegistry();
  reg.loadFromDirectory(skillsDir);
  return reg;
}

export async function skillsListCommand(opts: SkillsOptions): Promise<void> {
  const { dir } = resolveSkillsDir(opts);
  const reg = loadRegistry(dir);

  if (reg.size === 0) {
    p.note(
      `No skills found in ${dir}\n\n` +
        `Add one with:  openacme skills add <path-to-skill-folder>`,
      "Skills"
    );
    return;
  }

  const lines = reg.getIndex().map((e) => {
    const tags = e.tags.length > 0 ? `  [${e.tags.join(", ")}]` : "";
    return `  ${e.name}${tags}\n    ${e.description}`;
  });
  p.note(lines.join("\n\n"), `Skills (${reg.size}) — ${dir}`);
}

export async function skillsViewCommand(
  name: string,
  opts: SkillsOptions
): Promise<void> {
  const { dir } = resolveSkillsDir(opts);
  const reg = loadRegistry(dir);
  const skill = reg.getSkill(name);
  if (!skill) {
    p.cancel(`Skill not found: ${name}`);
    process.exitCode = 1;
    return;
  }

  const header =
    `name: ${skill.name}\n` +
    `description: ${skill.description}\n` +
    (skill.tags.length > 0 ? `tags: ${skill.tags.join(", ")}\n` : "") +
    `path: ${skill.dirPath}\n` +
    (skill.resources.length > 0
      ? `resources:\n` +
        skill.resources.map((r) => `  - ${r.relPath} (${r.size}B)`).join("\n") +
        "\n"
      : "");

  p.note(header + "\n---\n\n" + skill.body, "Skill");
}

export async function skillsAddCommand(
  sourcePath: string,
  opts: SkillsOptions
): Promise<void> {
  const src = path.resolve(sourcePath);

  if (!fs.existsSync(src)) {
    p.cancel(`Source path not found: ${src}`);
    process.exitCode = 1;
    return;
  }

  const stat = fs.statSync(src);
  let srcDir: string;
  if (stat.isFile()) {
    if (path.basename(src) !== "SKILL.md") {
      p.cancel(`Expected a SKILL.md file or a folder containing one. Got: ${src}`);
      process.exitCode = 1;
      return;
    }
    srcDir = path.dirname(src);
  } else if (stat.isDirectory()) {
    if (!fs.existsSync(path.join(src, "SKILL.md"))) {
      p.cancel(`No SKILL.md found in: ${src}`);
      process.exitCode = 1;
      return;
    }
    srcDir = src;
  } else {
    p.cancel(`Unsupported source path: ${src}`);
    process.exitCode = 1;
    return;
  }

  // Parse the source skill so we know its canonical name (from frontmatter,
  // not the source folder).
  let parsed;
  try {
    parsed = parseSkillDirectory(
      path.join(srcDir, "SKILL.md"),
      path.basename(srcDir)
    );
  } catch (e) {
    p.cancel(
      `Failed to parse SKILL.md: ${e instanceof Error ? e.message : String(e)}`
    );
    process.exitCode = 1;
    return;
  }

  const safeName = parsed.name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!safeName) {
    p.cancel(`Skill has an invalid name: ${parsed.name}`);
    process.exitCode = 1;
    return;
  }

  const { dir: skillsDir } = resolveSkillsDir(opts);
  const dest = path.join(skillsDir, safeName);

  if (fs.existsSync(dest)) {
    const overwrite = await p.confirm({
      message: `Skill '${safeName}' already exists at ${dest}. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel("Aborted.");
      return;
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.cpSync(srcDir, dest, { recursive: true, dereference: true });
  p.outro(`Installed '${safeName}' from ${srcDir} → ${dest}`);
}

export async function skillsRemoveCommand(
  name: string,
  opts: SkillsOptions
): Promise<void> {
  const { dir } = resolveSkillsDir(opts);
  const reg = loadRegistry(dir);
  const skill = reg.getSkill(name);
  if (!skill) {
    p.cancel(`Skill not found: ${name}`);
    process.exitCode = 1;
    return;
  }

  const confirm = await p.confirm({
    message: `Delete '${name}' at ${skill.dirPath}?`,
    initialValue: false,
  });
  if (p.isCancel(confirm) || !confirm) {
    p.cancel("Aborted.");
    return;
  }

  fs.rmSync(skill.dirPath, { recursive: true, force: true });
  p.outro(`Removed '${name}'.`);
}
