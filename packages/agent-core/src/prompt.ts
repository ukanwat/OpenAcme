/**
 * System prompt builder — assembles the system prompt from persona, skills, tools.
 * Mirrors Hermes agent/prompt_builder.py.
 */

export function buildSystemPrompt(options: {
  persona: string;
  toolNames: string[];
  skillsIndex?: string;
  memoryContext?: string;
  platformHints?: string;
}): string {
  const parts: string[] = [];

  // Identity / persona
  parts.push(options.persona);

  // Tool usage guidance
  if (options.toolNames.length > 0) {
    parts.push(
      `\n## Available Tools\nYou have access to the following tools: ${options.toolNames.join(", ")}.\n` +
        `Use tools proactively to gather information and complete tasks. ` +
        `When a task requires multiple steps, use tools sequentially until complete.`
    );
  }

  // Skills index (Level 0 — names + descriptions)
  if (options.skillsIndex) {
    parts.push(
      `\n## Skills\nYou have the following skills available:\n${options.skillsIndex}`
    );
  }

  // Memory context (USER.md / MEMORY.md)
  if (options.memoryContext) {
    parts.push(`\n## Memory\n${options.memoryContext}`);
  }

  // Platform-specific hints
  if (options.platformHints) {
    parts.push(`\n## Platform\n${options.platformHints}`);
  }

  return parts.join("\n\n");
}
