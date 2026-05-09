/**
 * System prompt builder — assembles the system prompt from persona, skills, tools.
 * Mirrors Hermes agent/prompt_builder.py.
 */

/**
 * Memory tool behavioral guidance. Ported verbatim from Hermes
 * `agent/prompt_builder.py:150-168` (`MEMORY_GUIDANCE`). Only injected when the
 * `memory` tool is available — otherwise it's noise.
 *
 * The declarative-vs-imperative paragraph is the load-bearing part: without
 * it, models save entries like "Always use Pino" which get re-read as
 * directives in every future session.
 */
const MEMORY_GUIDANCE =
  "You have persistent memory across sessions. Save durable facts using the memory " +
  "tool: user preferences, environment details, tool quirks, and stable conventions. " +
  "Memory is injected into every turn, so keep it compact and focused on facts that " +
  "will still matter later.\n" +
  "Prioritize what reduces future user steering — the most valuable memory is one " +
  "that prevents the user from having to correct or remind you again. " +
  "User preferences and recurring corrections matter more than procedural task details.\n" +
  "Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO " +
  "state to memory; use session_search to recall those from past transcripts. " +
  "If you've discovered a new way to do something, solved a problem that could be " +
  "necessary later, save it as a skill with the skill tool.\n" +
  "Write memories as declarative facts, not instructions to yourself. " +
  "'User prefers concise responses' ✓ — 'Always respond concisely' ✗. " +
  "'Project uses pytest with xdist' ✓ — 'Run tests with pytest -n 4' ✗. " +
  "Imperative phrasing gets re-read as a directive in later sessions and can " +
  "cause repeated work or override the user's current request. Procedures and " +
  "workflows belong in skills, not memory.";

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

  // Memory tool guidance — gated on the tool being available, mirrors
  // Hermes `run_agent.py:4874`. This stays in the prompt even when MEMORY.md
  // is empty so the agent knows the tool exists and what to save into it.
  if (options.toolNames.includes("memory")) {
    parts.push(`\n## Memory tool\n${MEMORY_GUIDANCE}`);
  }

  // Skills index (Level 0 — names + descriptions). Bodies aren't loaded
  // until the agent calls `skill_view` for one that applies.
  if (options.skillsIndex) {
    parts.push(
      `\n## Skills\nYou have the following skills available. Each entry is name + short description; ` +
        `call \`skill_view\` with the name to load the full instructions when one applies.\n${options.skillsIndex}`
    );
  }

  // Memory context (rendered MEMORY.md block — header + entries).
  // Empty when MEMORY.md is empty; skipped here so a fresh agent doesn't
  // see an empty section.
  if (options.memoryContext) {
    parts.push(`\n## Memory\n${options.memoryContext}`);
  }

  // Platform-specific hints
  if (options.platformHints) {
    parts.push(`\n## Platform\n${options.platformHints}`);
  }

  return parts.join("\n\n");
}
