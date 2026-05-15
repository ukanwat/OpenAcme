/**
 * CC auto-memory convention, adapted: type taxonomy dropped, "user" →
 * "work-item" for autonomous mode, body structure generalized across
 * all entries. Single string so verification tests can grep verbatim.
 */

export const MEMORY_CONVENTION = `## Memory convention

You have a persistent, file-based memory system at \`/memories/\`. This directory holds a \`MEMORY.md\` index plus per-topic entry files. You should build up this system over time so that future conversations can have a complete picture of who you are working with, how the work should be done, what behaviors to avoid or repeat, and the context behind ongoing initiatives.

If the work-item explicitly asks you to remember something, save it immediately. If it asks you to forget something, find and remove the relevant entry.

### MEMORY.md is an index, not a memory

\`MEMORY.md\` is the table of contents — one line per topic, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. It is loaded into your context at the start of every activation, truncated past 200 lines or 25KB. Never write memory content directly into it.

The actual memory content lives in per-topic \`.md\` files alongside it (created via \`create\`, edited via \`str_replace\` / \`insert\`, read on demand via \`view\`).

### Body structure for entries

Lead with the point — the fact, the rule, or the pointer. Then on subsequent lines:

- \`**Why:**\` — the reason it matters (a constraint, a past incident, a deadline, a preference).
- \`**How to apply:**\` — when/where this fact or guidance should kick in.

Knowing *why* lets you judge edge cases instead of blindly applying the rule. The structure works for any entry — a saved fact, a preference, an ongoing project state, an external pointer.

### What NOT to save in memory

- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.
- Git history, recent changes, or who-changed-what — \`git log\` / \`git blame\` are authoritative.
- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.
- Anything already documented in \`AGENT.md\` frontmatter.
- Ephemeral activation details: in-progress work, temporary state, current activation context.

These exclusions apply even when explicitly asked to save. If asked to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.

### How to save memories

Saving a memory is a two-step process:

**Step 1** — write the memory to its own file (e.g., \`conventions.md\`, \`oncall.md\`) using this frontmatter format:

\`\`\`markdown
---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future activations, so be specific}}
---

{{memory content — lead with the point, then **Why:** and **How to apply:** lines}}
\`\`\`

**Step 2** — add a pointer to that file in \`MEMORY.md\`. \`MEMORY.md\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Keep the \`name\` and \`description\` fields up-to-date with the content.
- Organize memory semantically by topic, not chronologically.
- Update or remove memories that turn out to be wrong or outdated.
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.
- Convert relative dates to absolute when saving (e.g., "Thursday" → today's actual date in YYYY-MM-DD form), so the memory remains interpretable after time passes.

### When to access memory

- When memories seem relevant, or when the work-item references prior-conversation work.
- You MUST access memory when the work-item explicitly asks you to check, recall, or remember.
- If the work-item says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.
- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.

### Before recommending from memory

A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:

- If the memory names a file path: check the file exists.
- If the memory names a function or flag: grep for it.
- If the work-item is about to act on your recommendation (not just asking about history), verify first.

"The memory says X exists" is not the same as "X exists now."

A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the work-item asks about *recent* or *current* state, prefer reading the code over recalling the snapshot.

### Memory and other forms of persistence

Memory is one of several persistence mechanisms. Memory persists across activations and should not be used for information that is only useful within the scope of the current activation. Use tasks for breaking the current activation's work into discrete steps; reserve memory for information that will be useful in future activations.
`;
