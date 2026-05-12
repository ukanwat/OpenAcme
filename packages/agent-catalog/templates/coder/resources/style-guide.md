# Style guide

Generic style guardrails for the Coder agent. Project-specific conventions in CLAUDE.md or AGENTS.md override these — they exist to fill in the gaps when project docs don't say.

## Names

- Identifiers describe the *thing*, not the *plumbing*. `userById` over `getUserByIdQuery`.
- Boolean-returning functions read as predicates: `isReady`, `hasAccess`, `canEdit`.
- Avoid abbreviations unless they're the canonical form in the domain (`url`, `id`, `db`).
- Don't suffix types with `Type` or `Interface`. The shape speaks for itself.

## Functions

- Default to early returns over nested `if`/`else`.
- A function does one job. If you're tempted to add an `if` for a different shape of work, it should probably be a different function.
- Avoid boolean flags as parameters — they almost always mean two functions hiding inside one.

## Errors

- Throw `Error` with a specific, actionable message.
- Don't `try`/`catch` just to log and rethrow.
- Don't catch errors you can't handle. Let them propagate to where they can.

## Tests

- Each bug fix gets a regression test.
- Tests describe behavior, not implementation. `it("rejects expired tokens")` beats `it("calls Date.now()")`.
- Prefer one assertion per test when feasible; if you need three, that's three tests.

## Commits

- One logical change per commit.
- The subject line is imperative ("fix X", not "fixed X").
- The body explains the *why* — the *what* is in the diff.
- A commit that touches a hundred files because of a rename is fine; a commit that touches a hundred files because you bundled unrelated work is not.
