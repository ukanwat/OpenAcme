import { z } from 'zod';
import { registry } from "../registry.js";

/**
 * Minimal skill shape this tool needs. Defined locally so `@openacme/tools`
 * doesn't pull in `@openacme/skills` at runtime — `bindSkillView` is wired
 * up by `AgentManager` during boot, mirroring `bindSessionSearch`.
 */
export interface SkillViewEntry {
  name: string;
  description: string;
  tags: string[];
  body: string;
  dirPath: string;
  resources: { relPath: string; size: number }[];
}

export interface SkillViewBindings {
  lookup: (name: string) => SkillViewEntry | null;
  list: () => { name: string; description: string; tags: string[] }[];
}

let bindings: SkillViewBindings | null = null;

export function bindSkillView(b: SkillViewBindings): void {
  bindings = b;
}

registry.register({
  name: "skill_view",
  toolset: "skills",
  description:
    "Load the full body of a skill by name (Level 1 progressive disclosure). " +
    "The skills index in your system prompt lists what's available; call this " +
    "to pull in a skill's instructions when one applies. Returns the SKILL.md " +
    "body, the skill's directory path, and a list of companion files (scripts, " +
    "references) — read those with `read_file` or run them with `shell` as needed.",
  parameters: z.object({
    name: z
      .string()
      .min(1)
      .describe("The kebab-case skill name from the skills index."),
  }),
  emoji: "📚",
  parallelSafe: true,
  handler: async (args) => {
    const { name } = args as { name: string };
    if (!bindings) {
      return JSON.stringify({
        error:
          "skill_view not initialized — AgentManager must call bindSkillView().",
      });
    }

    const skill = bindings.lookup(name);
    if (!skill) {
      const available = bindings.list().map((s) => s.name);
      return JSON.stringify({
        error: `Skill not found: ${name}`,
        available,
      });
    }

    return JSON.stringify({
      success: true,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      body: skill.body,
      dirPath: skill.dirPath,
      resources: skill.resources.map((r) => ({
        relPath: r.relPath,
        size: r.size,
      })),
    });
  },
});
