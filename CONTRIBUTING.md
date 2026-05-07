# Contributing

Thanks for working on OpenAcme. This guide currently focuses on the **release process** — sections on local development setup and PR conventions can be added as the project grows.

## Releasing

OpenAcme uses [Changesets](https://github.com/changesets/changesets) to manage versions, changelogs, and npm publishing across the workspace. The release workflow at [.github/workflows/release.yml](.github/workflows/release.yml) is **manually triggered** — releases are deliberate, never automatic.

### What gets published

The nine `@openacme/*` packages: [`cli`](apps/cli), [`server`](packages/server), [`agent-core`](packages/agent-core), [`llm-provider`](packages/llm-provider), [`mcp-client`](packages/mcp-client), [`skills`](packages/skills), [`tools`](packages/tools), [`db`](packages/db), [`config`](packages/config).

Not published: `@repo/*` (internal tooling), `apps/web`, `apps/docs`.

### Day-to-day: declaring a version bump

After making code changes, from the repo root:

```sh
pnpm changeset
```

This is interactive. It asks:

1. **Which packages changed?** Toggle with space, enter to confirm.
2. **Bump type per package?** `patch`, `minor`, or `major`.
3. **Summary?** One line. This becomes the CHANGELOG entry.

It writes a markdown file under `.changeset/`. Commit it alongside your code changes — typically in the same PR.

#### Bump types

| Type    | When                              | Example         |
| ------- | --------------------------------- | --------------- |
| `patch` | Bugfix, no API change             | `0.1.1 → 0.1.2` |
| `minor` | New feature, backwards compatible | `0.1.1 → 0.2.0` |
| `major` | Breaking change                   | `0.1.1 → 1.0.0` |

#### Internal deps update automatically

If you bump `@openacme/config`, every package depending on it via `workspace:*` (e.g. `@openacme/agent-core`, `@openacme/server`, …) gets an auto patch bump. You don't have to list them in `pnpm changeset`. This is governed by `updateInternalDependencies: "patch"` in [`.changeset/config.json`](.changeset/config.json).

#### Skipping a package

Just don't tick it in the prompt — it stays at its current version.

### Shipping: pick one of two flows

#### Flow A — PR-reviewed (recommended once you have collaborators)

1. Push your code + the changeset file to `main`.
2. Trigger the workflow:
   ```sh
   gh workflow run release.yml --repo ukanwat/OpenAcme
   ```
   It opens a **"Version Packages"** PR that bumps versions in every affected `package.json` and updates each package's `CHANGELOG.md`.
3. Review, merge that PR.
4. Trigger the workflow again:
   ```sh
   gh workflow run release.yml --repo ukanwat/OpenAcme
   ```
   No pending changesets this time, so it publishes everything whose local version is ahead of the registry.

#### Flow B — One-shot (good for solo / trivial patches)

1. After committing the changeset, consume it locally:
   ```sh
   pnpm version-packages
   ```
   This bumps versions, writes CHANGELOG entries, and deletes the changeset file.
2. Commit + push.
3. Trigger the workflow once — it goes straight to publish.
   ```sh
   gh workflow run release.yml --repo ukanwat/OpenAcme
   ```

Saves a round-trip, but skips PR review of the version bumps.

### Pre-releases (alpha / beta / rc)

```sh
pnpm changeset pre enter beta   # enter pre-release mode
pnpm changeset                  # declare bumps as usual
pnpm version-packages           # bumps to e.g. 0.2.0-beta.0

# iterate: more changesets → version-packages → 0.2.0-beta.1, beta.2 …

pnpm changeset pre exit         # leave pre-release mode
pnpm version-packages           # next bump produces final 0.2.0
```

### How the workflow decides what to do

The `changesets/action@v1` step in `release.yml` branches on whether `.changeset/` contains pending `*.md` files:

- **Pending changesets** → opens or updates a "Version Packages" PR. Does **not** publish.
- **No pending changesets** → runs `pnpm release` (= `turbo run build && changeset publish`). Publishes any package whose `version` in `package.json` is greater than the version on the npm registry. Already-published versions are skipped.

That's why Flow B works — you do the version bump locally, leaving no changesets, and the workflow's only remaining job is to publish.

### Provenance

[npm provenance](https://docs.npmjs.com/generating-provenance-statements) is currently **disabled** (`publishConfig.provenance: false` in each manifest) because it requires the source repo to be public, and `ukanwat/OpenAcme` is private.

To re-enable later:

1. Flip the GitHub repo to public (Settings → General → Danger Zone).
2. Set `publishConfig.provenance: true` in each of the nine manifests.
3. Re-add `id-token: write` to `permissions` and `NPM_CONFIG_PROVENANCE: "true"` to `env` in `release.yml`.

Existing published versions stay un-attested forever; new ones get the verified badge.

### The `NPM_TOKEN` secret

The workflow auths to npm via `secrets.NPM_TOKEN`, which is configured in the repo's GitHub Actions secrets. It must:

- Be scoped to the `openacme` org with publish rights.
- Be a Granular Access Token (preferred) or a classic Automation token.
- Have **Allow access tokens to bypass 2FA** enabled at the org level if 2FA-on-publish is required.

Rotate before expiry. If you regenerate, just update the `NPM_TOKEN` secret — no other code changes needed.

### Troubleshooting

**`E422 ... Unsupported GitHub Actions source repository visibility: "private"`** — provenance is on but the repo is private. Either turn off provenance (see above) or make the repo public.

**`E403 ... 403 Forbidden`** — the token doesn't have publish rights to `@openacme`, or 2FA-on-publish is blocking it.

**`E409 ... cannot publish over the previously published versions`** — you tried to publish a version that already exists. Bump the version (write a new changeset and run `pnpm version-packages`) and re-trigger.

**Workflow runs but publishes nothing** — every package's local version equals what's already on the registry. That's expected if there are no pending changesets and no manual bumps; nothing new to ship.
