# Git and commits

Rules for working in a git repository safely, and for writing commits the team will want to read.

## Safety protocol

- **NEVER update the git config** unless explicitly asked.
- **NEVER run destructive git commands** — `push --force`, `reset --hard`, `checkout .`, `restore .`, `clean -f`, `branch -D` — without an explicit user instruction. Lost work cannot be recovered.
- **NEVER skip hooks** — `--no-verify`, `--no-gpg-sign`, etc. — unless the user explicitly asks. If a hook fails, fix the underlying issue.
- **NEVER force-push to main/master.** Warn the user if asked.
- **NEVER commit unless the user asks.** It is critical to only commit when explicitly requested — being too proactive here destroys trust. If unclear, ask.
- **Prefer adding files by name** (`git add path/to/file`) over `git add -A` / `git add .` — wildcards can sweep in `.env`, credentials, build artifacts.

## When a pre-commit hook fails

The commit did NOT happen. Do not use `--amend` to "retry" — `--amend` would modify the *previous* commit and may destroy unrelated work.

The right sequence is:

1. Read the hook output.
2. Fix the issue.
3. Re-stage the fixed files.
4. Create a NEW commit.

`--amend` is reserved for the user explicitly asking to amend a specific commit.

## Commit messages

- **Subject line is imperative**, present tense: "fix auth retry", not "fixed auth retry" or "fixes auth retry".
- **Keep the subject under ~70 characters.** Details go in the body.
- **The body explains the WHY**, not the what. The diff shows what; the body explains the motivation, the constraint, the prior incident.
- **One logical change per commit.** A rename that touches a hundred files is fine. A hundred files bundling three unrelated changes is not.
- **No emojis, no AI-attribution footers** unless the user explicitly asks for them.

Use a heredoc so the formatting survives shell escaping:

```
git commit -m "$(cat <<'EOF'
fix(auth): retry token refresh on 401

The cached token was being reused after a 401 because the
refresh path only fired on 403. Retry on 401 too.
EOF
)"
```

## Workflow when the user asks for a commit

Run in parallel:

1. `git status` (without `-uall`, which is memory-heavy on large repos).
2. `git diff` to see staged + unstaged changes.
3. `git log -n 5` to learn the repo's commit style.

Then:

4. Draft the message. Make sure it accurately reflects all staged changes — not just the last thing you did.
5. Don't stage files that look sensitive (`.env`, `credentials.json`, anything matching `*.key`). Warn the user if they specifically request it.
6. Stage by name; create the commit; run `git status` after to confirm.

If there are no changes to commit, do not create an empty commit — say so.

## Pull requests

Only open a PR when the user asks. Before opening:

- Confirm the branch tracks a remote.
- Read the full commit list since divergence from base (`git log base...HEAD`), not just the last commit.
- Title: short (under 70 chars). Details go in the body.
- Body: `## Summary` (1-3 bullets), `## Test plan` (checklist of what to verify).

Return the PR URL when done.

## Repo conventions override these rules

If the project's `AGENTS.md`, `CLAUDE.md`, or a nearby `CONTRIBUTING.md` specifies different commit conventions (e.g., trunk-based with no PRs, conventional commits, sign-off required), follow those. This file is a default, not an override.
