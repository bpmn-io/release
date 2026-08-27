#!/usr/bin/env node

import { release, ReleaseError } from '../lib/release.js';
import { setVersion } from '../lib/version.js';
import { createInteractivePrompter, createScriptedPrompter } from '../lib/prompt.js';

const HELP = `Usage: bio-release [options]
       bio-release version <version> [options]

Publish changed packages of an npm monorepo to npm, in dependency order.
The release strategy is configured (and required) via package.json#releaseConfig.strategy.

Commands:
  version <spec...>    stamp versions onto every workspace package (including
                       private ones) and reconcile the lockfile — no commit, no
                       tag, no prompt, no build, no publish. Accepts an explicit
                       version, a bump level, or per-package "name=spec".
                       Run "bio-release version --help" for details.

Options:
  --cwd <dir>          repository root (default: current directory)
  --bump <spec>        non-interactive bump; repeatable. Either a bare spec
                       applied to every package ("--bump minor") or a
                       per-package "name=spec" (e.g. "--bump @scope/pkg=patch").
                       For "fixed", a single bare spec sets the shared bump.
                       A spec is a level (patch | minor | major | premajor |
                       preminor | prepatch | prerelease | skip) or an explicit
                       version (e.g. "--bump 1.2.3").
  --preid <id>         pre-release identifier for pre* bumps (default: alpha),
                       e.g. "alpha", "beta", "rc", "next".
  --dist-tag <tag>     npm dist-tag to publish under. Defaults to "latest" for
                       stable versions. A pre-release has no default: it requires
                       an explicit, non-"latest" dist-tag (e.g. --dist-tag next).
  --no-private         exclude private packages from the release entirely. By
                       default they are versioned, committed and tagged like any
                       other package, but never published to the registry.
  --force-release      release every eligible package, bypassing change
                       detection. Use for a monorepo whose packages must
                       always move together.
  --no-build           skip the build step ("npm run all") for all packages.
                       A package without an "all" script is skipped anyway,
                       with a warning.
  -y, --yes            skip the confirmation prompt (required for a
                       non-interactive run to actually publish)
  -h, --help           show this help

Examples:
  bio-release
  bio-release --bump minor --yes
  bio-release --bump @scope/a=patch --bump @scope/b=minor --yes
  bio-release --bump preminor --preid alpha --yes
  bio-release --bump prerelease --preid beta --dist-tag beta --yes
  bio-release --bump @scope/a=1.2.3 --bump @scope/b=minor --yes
  bio-release version 1.2.0-nightly.0
  bio-release version @scope/a=1.2.3 @scope/b=minor
`;

const VERSION_HELP = `Usage: bio-release version <spec...> [options]

Stamp versions onto workspace packages (including private ones) and reconcile the
lockfile. This is version-only: it makes NO commit, NO git tag, NO prompt, NO
build and NO publish — unlike a full release. Use it in CI/nightly pipelines that
need to stamp a computed version before building artifacts.

Arguments:
  <spec...>            one or more version specs. A bare spec applies to every
                       package; a "name=spec" targets a specific package (and
                       wins over the bare default). Packages with no spec are
                       left untouched. Each spec is either an explicit semver
                       version (e.g. 1.2.3, 1.2.0-nightly.0) or a bump level
                       (patch | minor | major | premajor | preminor | prepatch |
                       prerelease), resolved off the package's current version.

Options:
  --cwd <dir>          repository root (default: current directory)
  --preid <id>         pre-release identifier for pre* bump levels (default: alpha)
  --no-private         leave private packages untouched instead of stamping them
  -h, --help           show this help

Examples:
  bio-release version 1.2.0-nightly.0
  bio-release version 1.2.3 --cwd ./repo
  bio-release version 1.2.3 --no-private
  bio-release version @scope/a=1.2.3 @scope/b=minor
`;

function parseArgs(argv) {
  const opts = { bumps: {}, yes: false, interactive: true, build: true };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-y' || arg === '--yes') {
      opts.yes = true;
    } else if (arg === '--cwd') {
      opts.cwd = argv[++i];
    } else if (arg === '--preid') {
      opts.preid = argv[++i];
    } else if (arg === '--dist-tag') {
      opts.distTag = argv[++i];
    } else if (arg === '--no-private') {
      opts.excludePrivate = true;
    } else if (arg === '--force-release') {
      opts.forceRelease = true;
    } else if (arg === '--no-build') {
      opts.build = false;
    } else if (arg === '--bump') {
      const value = argv[++i];
      opts.interactive = false;
      if (value && value.includes('=')) {
        const idx = value.lastIndexOf('=');
        opts.bumps[value.slice(0, idx)] = value.slice(idx + 1);
      } else {
        opts.defaultBump = value;
      }
    } else {
      console.error(`Unknown argument: ${arg}\n`);
      console.error(HELP);
      process.exit(1);
    }
  }

  return opts;
}

function parseVersionArgs(argv) {
  const opts = { excludePrivate: false, overrides: {} };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '--cwd') {
      opts.cwd = argv[++i];
    } else if (arg === '--preid') {
      opts.preid = argv[++i];
    } else if (arg === '--no-private') {
      opts.excludePrivate = true;
    } else if (arg.startsWith('-')) {
      console.error(`Unknown argument: ${arg}\n`);
      console.error(VERSION_HELP);
      process.exit(1);
    } else if (arg.includes('=')) {
      const idx = arg.lastIndexOf('=');
      opts.overrides[arg.slice(0, idx)] = arg.slice(idx + 1);
    } else if (opts.defaultSpec === undefined) {
      opts.defaultSpec = arg;
    } else {
      console.error(`Unexpected argument: ${arg} (only one bare version may be given)\n`);
      console.error(VERSION_HELP);
      process.exit(1);
    }
  }

  return opts;
}

async function versionMain(argv) {
  const opts = parseVersionArgs(argv);

  if (opts.help) {
    console.log(VERSION_HELP);
    return;
  }

  if (opts.defaultSpec === undefined && Object.keys(opts.overrides).length === 0) {
    console.error('Missing required version. Pass a version, a bump level, or per-package assignments.\n');
    console.error(VERSION_HELP);
    process.exit(1);
  }

  await setVersion(opts.defaultSpec, {
    cwd: opts.cwd,
    excludePrivate: opts.excludePrivate,
    overrides: opts.overrides,
    preid: opts.preid
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === 'version') {
    await versionMain(argv.slice(1));
    return;
  }

  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(HELP);
    return;
  }

  const prompter = opts.interactive
    ? createInteractivePrompter({ preid: opts.preid, defaultDistTag: opts.distTag })
    : createScriptedPrompter({ bumps: opts.bumps, bump: opts.defaultBump, preid: opts.preid, yes: opts.yes });

  await release({
    cwd: opts.cwd,
    distTag: opts.distTag,
    excludePrivate: opts.excludePrivate,
    forceRelease: opts.forceRelease,
    build: opts.build,
    prompter
  });
}

try {
  await main();
} catch (err) {
  if (err instanceof ReleaseError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
