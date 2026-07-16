#!/usr/bin/env node

import { release, ReleaseError } from '../lib/release.js';
import { createInteractivePrompter, createScriptedPrompter } from '../lib/prompt.js';

const HELP = `Usage: bio-release [options]

Publish changed packages of an npm monorepo to npm, in dependency order.
The release strategy is configured (and required) via package.json#releaseConfig.strategy.

Options:
  --cwd <dir>          repository root (default: current directory)
  --bump <spec>        non-interactive bump; repeatable. Either a bare level
                       applied to every package ("--bump minor") or a
                       per-package "name=level" (e.g. "--bump @scope/pkg=patch").
                       For "fixed", a single bare level sets the shared bump.
                       Levels: patch | minor | major |
                               premajor | preminor | prepatch | prerelease | skip.
  --preid <id>         pre-release identifier for pre* bumps (default: alpha),
                       e.g. "alpha", "beta", "rc", "next".
  --dist-tag <tag>     npm dist-tag to publish under. Defaults to "latest" for
                       stable versions. A pre-release has no default: it requires
                       an explicit, non-"latest" dist-tag (e.g. --dist-tag next).
  -y, --yes            skip the confirmation prompt (required for a
                       non-interactive run to actually publish)
  -h, --help           show this help

Examples:
  bio-release
  bio-release --bump minor --yes
  bio-release --bump @scope/a=patch --bump @scope/b=minor --yes
  bio-release --bump preminor --preid alpha --yes
  bio-release --bump prerelease --preid beta --dist-tag beta --yes
`;

function parseArgs(argv) {
  const opts = { bumps: {}, yes: false, interactive: true };

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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(HELP);
    return;
  }

  const prompter = opts.interactive
    ? createInteractivePrompter({ defaultPreid: opts.preid, defaultDistTag: opts.distTag })
    : createScriptedPrompter({ bumps: opts.bumps, bump: opts.defaultBump, preid: opts.preid, yes: opts.yes });

  await release({
    cwd: opts.cwd,
    distTag: opts.distTag,
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
