# Style guide

Generic style guardrails. Project conventions in `AGENTS.md` or nearby `CLAUDE.md` files override these.

## Names

- Identifiers describe the *thing*, not the *plumbing*. `userById` over `getUserByIdQuery`.
- Boolean-returning functions read as predicates: `isReady`, `hasAccess`, `canEdit`.
- Avoid abbreviations unless they're the canonical form in the domain (`url`, `id`, `db`).
- Don't suffix types with `Type` or `Interface`. The shape speaks for itself.

## Functions

- Default to early returns over nested `if`/`else`.
- A function does one job. If you're tempted to add an `if` for a different shape of work, it should probably be a different function.
- Avoid boolean flags as parameters — they almost always mean two functions hiding inside one.
- Keep parameter lists short. If you need more than four, the function is probably doing too much or wants an options object.

## Errors

- Throw `Error` with a specific, actionable message — what went wrong and what was being attempted.
- Don't `try`/`catch` just to log and rethrow.
- Don't catch errors you can't handle. Let them propagate to where they can.
- Validate at boundaries (HTTP, files, env vars, user input). Trust the type inside.

## Types

- Prefer narrow types over wide ones. `"open" | "closed"` beats `string`.
- Don't `any` your way out of a hard type. If you genuinely don't know the shape, use `unknown` and narrow at the use site.
- Don't define parallel types when the framework already exports one. Re-export from the canonical source.

## Tests

- Each bug fix gets a regression test.
- Tests describe behavior, not implementation. `it("rejects expired tokens")` beats `it("calls Date.now()")`.
- Prefer one assertion per test when feasible; if you need three, that's three tests.
- Avoid mocking the unit under test. Mock the boundary, not the thing.
