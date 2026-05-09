---
paths:
  - "packages/tools/**"
---

# tools

Singleton `ToolRegistry` (`registry.ts`) + built-in handlers in `builtins/`. Tools self-register at module load. MCP tools register dynamically via `@openacme/mcp-client`. The registry is the boundary between agent-core and concrete tool implementations.

## Self-registration: import order = registration order

Built-ins are loaded by importing them for side effects in `src/index.ts`. The order in that file **is** the registration order; reordering changes which tool wins a name collision and which tool the LLM sees first in the system-prompt list.

- New built-in: create `builtins/<name>.ts`, call `registry.register({...})` at module top-level, import the file in `index.ts`.
- Tools are stateless. Live state goes through bindings (next section), not closures over module-scope vars.

## Shadowing rule rejects same-name across toolsets

`registry.ts:18`: same `name`, different `toolset` → throws. Same name across two MCP toolsets → allowed (legitimate: server refresh re-registers).

- Built-in vs MCP collision is rejected. If MCP wants to ship a `shell`, it must namespace itself (it does, as `mcp-<server>__shell`).
- Don't suppress the error — fix the name.

## Runtime binding pattern for tools needing app state

`session_search` and `skill_view` are registered with **placeholder** handlers in `builtins/`. `AgentManager` calls `bindSessionSearch({...})` (`agent-manager.ts:55`) and `bindSkillView({...})` (`:74`) to install the real closures over `messageStore.search` and `skillRegistry.getSkill`.

- Why: keeps `@openacme/tools` free of dependencies on `@openacme/db` and `@openacme/skills`. The tools package ships clean even if those evolve.
- New tool that needs DB or other live state: register a placeholder, expose a `bindX(...)` setter in `index.ts`, call it from AgentManager.

## ToolEntry shape & contract

`types.ts` — `name`, `toolset`, `description`, `parameters: ZodSchema`, `handler: (args) => Promise<string>`, plus optional `emoji`, `parallelSafe`, `maxResultSizeChars`, `checkFn`.

- `handler` returns a **JSON-stringified string**, not an object. Vercel AI SDK consumes strings on the tool side.
- The registry **does not clip results.** Long output → enforce `maxResultSizeChars` inside the handler. See `shell.ts` (50KB cap).
- `checkFn()` gates availability per-call (e.g., disable `python_repl` if Python isn't installed). Returning false hides the tool from the LLM's tool list but keeps it registered.
- `parallelSafe: false` tells callers not to dispatch this tool concurrently with itself.

## Zod for params, never hand-rolled JSON Schema

`zodToJsonSchema` is already imported in `registry.ts`. Use it. Hand-rolling JSON Schema diverges from runtime validation and breaks Vercel AI SDK's tool conversion.

## Session id via AsyncLocalStorage, not args

`toolCallContext` (`session-context.ts`) is set by `Agent.runStream`. Inside a handler:

```ts
const sessionId = toolCallContext.getStore()?.sessionId;
```

Never add `sessionId` to a tool's Zod schema — bloats every schema and exposes the id to the model.

## Tests live in `test/`, vitest

`session-search.test.ts`, `edit.test.ts`, `apply-patch.test.ts`, `web-search.test.ts`, `web-extract.test.ts`, `patch-parser.test.ts`. New tool = new test, even if trivial — built-ins are the most-edited surface in the codebase.
