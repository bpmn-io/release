# @bpmn-io/release

[![CI](https://github.com/bpmn-io/release/actions/workflows/CI.yml/badge.svg)](https://github.com/bpmn-io/release/actions/workflows/CI.yml)

Publish changed packages of an npm monorepo.

Discovers workspace packages from `package.json#workspaces` (globs expanded;
private packages are included by default, versioned + tagged but never
published, unless `--no-private` is set), orders them
topologically, detects what changed since
the last release, asks for a version bump per package, then applies every bump in
a single commit and publishes + tags each package against that one commit.

## Usage

Use via [command line](#cli) or as [a library](#programmatic-api).

## Requirements

* Builder package uses [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces).
* Each package exposes a `npm run all` script
* A [configured release strategy](#strategy)

## Strategy

The strategy is **required** and read from the root `package.json`:

```jsonc
{
  "releaseConfig": {
    "strategy": "independent" // or "fixed"
  }
}
```

- **`independent`** — each package is versioned and released on its own; tags are
  `name@version`. Dependents cascade in when a workspace dependency is released.
- **`fixed`** — released packages share one version, detected against the `vX.Y.Z`
  release tag and published together under a single new `vX.Y.Z` tag. Only packages
  that changed since the baseline (plus the dependents they cascade in) are
  released; unchanged packages keep their current version and rejoin the shared
  version the next time they change.

### Commit message

The single release commit defaults to `chore(packages): release` — and
`chore(packages): release %version` under the `fixed` strategy. Override it via
`releaseConfig.commitMessage`:

```jsonc
{
  "releaseConfig": {
    "strategy": "fixed",
    "commitMessage": "chore(packages): release %version"
  }
}
```

The `%version` placeholder is replaced with the `v`-prefixed release version
(e.g. `v1.2.3`, matching the `vX.Y.Z` release tag) — so the example above yields
`chore(packages): release v1.2.3`. Because a single shared version only exists
under the `fixed` strategy, `%version` may **not** be used with `independent`.

## CLI

```bash
# interactive
npx @bpmn-io/release

# non-interactive (CI)
npx @bpmn-io/release --bump minor --yes
npx @bpmn-io/release --bump @scope/a=patch --bump @scope/b=minor --yes

# non-interactive: cut 1.3.0-alpha.0 under dist-tag "next"
npx @bpmn-io/release --bump preminor --preid alpha --dist-tag next --yes

# exclude private packages from the release entirely
npx @bpmn-io/release --no-private --bump minor --yes

# force every eligible package to release, even ones without changes
npx @bpmn-io/release --force-release --bump minor --yes

# skip the per-package build step entirely
npx @bpmn-io/release --no-build --bump minor --yes
```

For all flags, run `npx @bpmn-io/release --help`.

## Private packages

By default private packages (`"private": true` in their `package.json`) are
versioned, committed and tagged alongside the public ones — they are just never
published to the registry. This is useful for monorepos whose deployable
artifacts (apps, bundles) live in private workspaces but still need a shared
version bump and a git tag to drive the actual release (e.g. through a CI
pipeline build). With a `fixed` strategy this covers the common "bump everything,
tag it, publish nothing" case. Pass `--no-private` to leave private packages out
of the release entirely.

## Force release

By default a package is only released if it changed since its last release tag.
Pass `--force-release` to release every eligible package regardless of whether it
changed. This is what you want when a set of packages form a single product that
must always move in lock-step under one shared version — e.g. a `fixed`-strategy
monorepo where a change to just one workspace should still bump and tag them all.

## Build step

Before a package is published (or tagged) its `all` npm script is run as a build
gate. This step is optional:

- if a package has no `all` script it is skipped, with a warning;
- pass `--no-build` to skip the build for every package regardless.

## Pre-releases

You can safely cut an `alpha` / `rc` release either through interactive
selection (you are asked for the pre-release identifier and dist-tag) or
non-interactively by passing a `--preid` alongside an explicit, non-`latest`
`--dist-tag` to publish under.

Pre-release bump levels start or advance a pre-release, and plain `patch` /
`minor` / `major` on a pre-release *graduate* it to the final version:

| current | bump (`--preid alpha`) | result |
| --- | --- | --- |
| `1.2.3` | `preminor` | `1.3.0-alpha.0` |
| `1.3.0-alpha.0` | `prerelease` | `1.3.0-alpha.1` |
| `1.3.0-alpha.1` | `minor` (graduate) | `1.3.0` |

Because publishing a pre-release move (graduating, or re-cutting after a botched
publish) may not touch any code since the last release tag, a package sitting on
a pre-release version is always offered for release — the usual "nothing changed,
skip it" gate does not apply while a pre-release is in progress.

## Programmatic API

```js
import { release, createScriptedPrompter } from '@bpmn-io/release';

const result = await release({
  cwd: process.cwd(),          // repository root
  logger: console,             // any { log, warn, error }
  distTag: 'next',             // required for pre-releases; never `latest`
  prompter: createScriptedPrompter({ bump: 'preminor', preid: 'alpha', yes: true })
});

// {
//   strategy, released: [{ name, version }], skipped: [name],
//   aborted?: boolean, tags?: [string]
// }
```

A **prompter** drives interactive decisions:

```js
{
  bump({ name, currentVersion }): { type, preid, distTag } | 'skip',
  confirm({ plan, strategy }): boolean,
  close(): void
}
```

`type` is one of `patch | minor | major | premajor | preminor | prepatch |
prerelease`, `preid` (e.g. `alpha`) is the pre-release identifier used by the
`pre*` types, and `distTag` is the npm dist-tag chosen for a pre-release (never
`latest`; omit it for a stable bump to default to `latest`).

`createInteractivePrompter({ defaultPreid, defaultDistTag })` (readline, the
default) and `createScriptedPrompter({ bumps, bump, preid, yes })` (head-less)
are provided.

`release()` returns its result rather than calling `process.exit`, and throws a
`ReleaseError` for expected failures (dirty tree, missing npm auth, missing
strategy). The CLI translates those into a non-zero exit.

## License

MIT
