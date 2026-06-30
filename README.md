# @bpmn-io/release

Publish changed packages of an npm monorepo.

Discovers workspace packages from `package.json#workspaces` (globs expanded,
private packages skipped), orders them topologically, detects what changed since
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
- **`fixed`** — all packages share one version, detected against the `vX.Y.Z`
  release tag and published together under a single new `vX.Y.Z` tag.

## CLI

```bash
# interactive
npx @bpmn-io/release

# non-interactive (CI)
npx @bpmn-io/release --bump minor --yes
npx @bpmn-io/release --bump @scope/a=patch --bump @scope/b=minor --yes
```

## Programmatic API

```js
import { release, createScriptedPrompter } from '@bpmn-io/release';

const result = await release({
  cwd: process.cwd(),          // repository root
  logger: console,             // any { log, warn, error }
  prompter: createScriptedPrompter({ bump: 'minor', yes: true })
});

// {
//   strategy, released: [{ name, version }], skipped: [name],
//   aborted?: boolean, tags?: [string]
// }
```

A **prompter** drives interactive decisions:

```js
{
  bump({ name, currentVersion }): 'patch' | 'minor' | 'major' | 'skip',
  confirm({ plan, strategy }): boolean,
  close(): void
}
```

`createInteractivePrompter()` (readline, the default) and
`createScriptedPrompter({ bumps, bump, yes })` (head-less) are provided.

`release()` returns its result rather than calling `process.exit`, and throws a
`ReleaseError` for expected failures (dirty tree, missing npm auth, missing
strategy). The CLI translates those into a non-zero exit.

## License

MIT