import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { readJSON } from '../lib/workspace.js';
import { createScriptedPrompter } from '../lib/prompt.js';

import { release, resolveDistTag, LATEST_DIST_TAG, ReleaseError } from '../lib/release.js';


const SILENT_LOGGER = { log() {}, warn() {}, error() {} };

/**
 * Materialize a throwaway workspace on disk. `pkgs` maps a workspace-relative
 * directory (`''` for the repo root) to the `package.json` written there.
 *
 * @param {Record<string, object>} pkgs
 * @return {string} the workspace root (caller is responsible for cleanup)
 */
function createWorkspace(pkgs) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-e2e-'));

  for (const [ rel, content ] of Object.entries(pkgs)) {
    const dir = join(cwd, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(content, null, 2) + '\n');
  }

  return cwd;
}

/**
 * A fake process runner modelling the git/npm world `release()` observes.
 * Every git/npm invocation funnels through the single `run` seam, so this stub
 * lets a full `release()` run without touching git, npm or the network. It
 * records every call for later assertions.
 *
 * @param {{
 *   npmVersions?: Record<string, string[]>,
 *   tags?: string[],
 *   changes?: Record<string, string[]>,
 *   whoami?: string|null,
 *   clean?: boolean,
 *   staleAfterInstall?: boolean
 * }} [world]
 */
function createRunner({ npmVersions = {}, tags = [], changes = {}, whoami = 'ci-bot', clean = true, staleAfterInstall = false } = {}) {
  const calls = [];
  let installed = false;

  async function run(file, args = [], opts = {}) {
    calls.push({ file, args: [ ...args ], opts, cmd: [ file, ...args ].join(' ') });

    // pre-flight: working tree status. A clean tree can still go dirty once
    // `npm install` refreshes a stale lockfile — modelled via staleAfterInstall.
    if (file === 'git' && args[0] === 'status') {
      if (!clean) return ' M packages/a/index.js';
      if (staleAfterInstall && installed) return ' M package-lock.json';
      return '';
    }

    // pre-flight: node_modules install (records that it ran)
    if (file === 'npm' && args[0] === 'install') {
      installed = true;
      return '';
    }

    // pre-flight: npm authentication
    if (file === 'npm' && args[0] === 'whoami') {
      if (!whoami) throw new Error('not authenticated with npm');
      return whoami;
    }

    // detect: highest published version (missing package → 404 → treated as unpublished)
    if (file === 'npm' && args[0] === 'view') {
      const versions = npmVersions[args[1]];
      if (!versions) throw new Error(`404 ${args[1]}`);
      return JSON.stringify(versions);
    }

    // detect: does a release tag exist?
    if (file === 'git' && args[0] === 'rev-parse') {
      if (tags.includes(args[1])) return args[1];
      throw new Error(`unknown revision ${args[1]}`);
    }

    // detect: commits touching a package dir since its baseline tag.
    // `release()` passes the platform-native dir (e.g. `packages\a` on Windows),
    // so normalize to POSIX separators to keep fixtures cross-platform.
    if (file === 'git' && args[0] === 'log') {
      const dir = args[args.length - 1].replaceAll(sep, '/');
      return (changes[dir] ?? []).join('\n');
    }

    // every mutating call (npm version/install/publish/run, git add/commit/tag/push)
    return '';
  }

  run.calls = calls;
  return run;
}

// commands recorded by the fake runner whose joined `file + args` starts with `prefix`
const commands = (run, prefix) => run.calls.filter(c => c.cmd.startsWith(prefix)).map(c => c.cmd);


test('release (end-to-end)', async (t) => {

  await t.test('independent — releases a changed package and cascades to its dependent', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0', scripts: { all: 'exit 0' } },
      'packages/c': { name: '@fix/c', version: '1.0.0', scripts: { all: 'exit 0' }, dependencies: { '@fix/a': '^1.0.0' } }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.0.0' ], '@fix/c': [ '1.0.0' ] },
      tags: [ '@fix/a@1.0.0', '@fix/c@1.0.0' ],
      changes: { 'packages/a': [ 'feat: add thing' ], 'packages/c': [] }
    });

    try {
      const result = await release({
        cwd,
        run,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'minor', yes: true })
      });

      assert.equal(result.strategy, 'independent');
      assert.deepEqual(result.released, [
        { name: '@fix/a', version: '1.1.0' },
        { name: '@fix/c', version: '1.1.0' }
      ]);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(result.tags, [ '@fix/a@1.1.0', '@fix/c@1.1.0' ]);

      // the dependent's range was pinned to the released version on disk
      const c = readJSON(join(cwd, 'packages/c', 'package.json'));
      assert.equal(c.dependencies['@fix/a'], '^1.1.0');

      // both packages were built, published to latest and tagged, then pushed
      assert.deepEqual(commands(run, 'npm run all'), [ 'npm run all', 'npm run all' ]);
      assert.deepEqual(commands(run, 'npm publish'), [ 'npm publish', 'npm publish' ]);
      assert.deepEqual(commands(run, 'git tag'), [ 'git tag @fix/a@1.1.0', 'git tag @fix/c@1.1.0' ]);
      assert.deepEqual(commands(run, 'git push'), [
        'git push origin HEAD',
        'git push origin @fix/a@1.1.0',
        'git push origin @fix/c@1.1.0'
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('independent — a per-package explicit version is stamped verbatim', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0', scripts: { all: 'exit 0' } }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.0.0' ] },
      tags: [ '@fix/a@1.0.0' ],
      changes: { 'packages/a': [ 'feat: add thing' ] }
    });

    try {
      const result = await release({
        cwd,
        run,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bumps: { '@fix/a': '1.2.3' }, yes: true })
      });

      assert.deepEqual(result.released, [ { name: '@fix/a', version: '1.2.3' } ]);
      assert.deepEqual(result.tags, [ '@fix/a@1.2.3' ]);
      assert.deepEqual(commands(run, 'npm version'), [ 'npm version 1.2.3 --no-git-tag-version' ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('independent — leaves a package out when its bump is skipped', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' },
      'packages/c': { name: '@fix/c', version: '1.0.0' }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.0.0' ], '@fix/c': [ '1.0.0' ] },
      tags: [ '@fix/a@1.0.0', '@fix/c@1.0.0' ],
      changes: { 'packages/a': [ 'fix: a' ], 'packages/c': [ 'fix: c' ] }
    });

    try {
      const result = await release({
        cwd,
        run,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bumps: { '@fix/a': 'patch', '@fix/c': 'skip' }, yes: true })
      });

      assert.deepEqual(result.released, [ { name: '@fix/a', version: '1.0.1' } ]);
      assert.deepEqual(result.skipped, [ '@fix/c' ]);
      assert.deepEqual(commands(run, 'git tag'), [ 'git tag @fix/a@1.0.1' ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('independent — warns when a stable package pins a pre-release dependency', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' },
      'packages/c': { name: '@fix/c', version: '1.0.0', dependencies: { '@fix/a': '^1.0.0' } }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.0.0' ], '@fix/c': [ '1.0.0' ] },
      tags: [ '@fix/a@1.0.0', '@fix/c@1.0.0' ],
      changes: { 'packages/a': [ 'feat: next' ], 'packages/c': [ 'fix: c' ] }
    });

    const warnings = [];
    const logger = { log() {}, warn: (msg) => warnings.push(msg), error() {} };

    try {
      const result = await release({
        cwd,
        run,
        distTag: 'next',
        logger,

        // @fix/a goes pre-release while its stable dependent @fix/c pins it
        prompter: createScriptedPrompter({ bumps: { '@fix/a': 'preminor', '@fix/c': 'patch' }, preid: 'alpha', yes: true })
      });

      assert.deepEqual(result.released, [
        { name: '@fix/a', version: '1.1.0-alpha.0' },
        { name: '@fix/c', version: '1.0.1' }
      ]);

      // @fix/c (stable 1.0.1) now pins the pre-release @fix/a@1.1.0-alpha.0 on disk
      assert.equal(readJSON(join(cwd, 'packages/c', 'package.json')).dependencies['@fix/a'], '^1.1.0-alpha.0');
      assert.ok(
        warnings.some(w => w.includes('@fix/c@1.0.1 (stable) pins pre-release @fix/a@1.1.0-alpha.0')),
        `expected a stable-pins-pre-release warning, got: ${JSON.stringify(warnings)}`
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('independent — publishes a pre-release under its explicit dist-tag', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.0.0' ] },
      tags: [ '@fix/a@1.0.0' ],
      changes: { 'packages/a': [ 'feat: next' ] }
    });

    try {
      const result = await release({
        cwd,
        run,
        distTag: 'next',
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'preminor', preid: 'alpha', yes: true })
      });

      assert.deepEqual(result.released, [ { name: '@fix/a', version: '1.1.0-alpha.0' } ]);
      assert.deepEqual(result.tags, [ '@fix/a@1.1.0-alpha.0' ]);

      // a pre-release is published under its non-latest dist-tag, never `latest`
      assert.deepEqual(commands(run, 'npm publish'), [ 'npm publish --tag next' ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('independent — refuses a pre-release without a dist-tag before publishing', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.0.0' ] },
      tags: [ '@fix/a@1.0.0' ],
      changes: { 'packages/a': [ 'feat: next' ] }
    });

    try {
      await assert.rejects(
        release({
          cwd,
          run,
          logger: SILENT_LOGGER,
          prompter: createScriptedPrompter({ bump: 'preminor', yes: true })
        }),
        /requires an explicit dist-tag/
      );

      // it fails fast — nothing is published before the guard trips
      assert.deepEqual(commands(run, 'npm publish'), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('fixed — releases all packages at one shared version and tag', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'fixed' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' },
      'packages/c': { name: '@fix/c', version: '1.0.0', dependencies: { '@fix/a': '^1.0.0' } }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.0.0' ], '@fix/c': [ '1.0.0' ] },
      tags: [ 'v1.0.0' ],
      changes: { 'packages/a': [ 'feat: shared change' ], 'packages/c': [] }
    });

    try {
      const result = await release({
        cwd,
        run,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'minor', yes: true })
      });

      assert.equal(result.strategy, 'fixed');
      assert.deepEqual(result.released, [
        { name: '@fix/a', version: '1.1.0' },
        { name: '@fix/c', version: '1.1.0' }
      ]);
      assert.deepEqual(result.tags, [ 'v1.1.0' ]);

      // the shared version is substituted into the release commit message
      assert.deepEqual(commands(run, 'git commit'), [ 'git commit -m chore(packages): release v1.1.0' ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('fixed — private packages are versioned + tagged but never published', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'fixed' } },
      'packages/a': { name: '@app/a', version: '1.0.0', private: true, scripts: { all: 'exit 0' } },
      'packages/b': { name: '@app/b', version: '1.0.0', private: true, scripts: { all: 'exit 0' } }
    });

    // no npmVersions: a private package's baseline comes from package.json,
    // never the registry
    const run = createRunner({
      tags: [ 'v1.0.0' ],
      changes: { 'packages/a': [ 'feat: a' ], 'packages/b': [ 'feat: b' ] }
    });

    try {
      const result = await release({
        cwd,
        run,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'minor', yes: true })
      });

      assert.deepEqual(result.released, [
        { name: '@app/a', version: '1.1.0' },
        { name: '@app/b', version: '1.1.0' }
      ]);
      assert.deepEqual(result.tags, [ 'v1.1.0' ]);

      // both are versioned, built and tagged — but never published, and neither
      // npm auth nor the registry is ever consulted for a private-only release
      assert.deepEqual(commands(run, 'npm version'), [
        'npm version 1.1.0 --no-git-tag-version',
        'npm version 1.1.0 --no-git-tag-version'
      ]);
      assert.deepEqual(commands(run, 'npm run all'), [ 'npm run all', 'npm run all' ]);
      assert.deepEqual(commands(run, 'npm publish'), []);
      assert.deepEqual(commands(run, 'npm whoami'), []);
      assert.deepEqual(commands(run, 'npm view'), []);
      assert.deepEqual(commands(run, 'git tag'), [ 'git tag v1.1.0' ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('fixed — private packages are excluded when excludePrivate is set', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'fixed' } },
      'packages/a': { name: '@app/a', version: '1.0.0', private: true }
    });

    const run = createRunner({ tags: [ 'v1.0.0' ], changes: { 'packages/a': [ 'feat: a' ] } });

    try {
      const result = await release({
        cwd,
        run,
        excludePrivate: true,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'minor', yes: true })
      });

      // nothing discovered → nothing released
      assert.deepEqual(result.released, []);
      assert.deepEqual(commands(run, 'git tag'), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('independent — a private package is tagged but not published alongside public ones', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' },
      'packages/b': { name: '@priv/b', version: '2.0.0', private: true }
    });

    const run = createRunner({

      // only the public package is on npm; both are tagged in git
      npmVersions: { '@fix/a': [ '1.0.0' ] },
      tags: [ '@fix/a@1.0.0', '@priv/b@2.0.0' ],
      changes: { 'packages/a': [ 'feat: a' ], 'packages/b': [ 'feat: b' ] }
    });

    try {
      const result = await release({
        cwd,
        run,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'minor', yes: true })
      });

      assert.deepEqual(result.released, [
        { name: '@fix/a', version: '1.1.0' },
        { name: '@priv/b', version: '2.1.0' }
      ]);
      assert.deepEqual(result.tags, [ '@fix/a@1.1.0', '@priv/b@2.1.0' ]);

      // only the public package is published; both are tagged
      assert.deepEqual(commands(run, 'npm publish'), [ 'npm publish' ]);
      assert.deepEqual(commands(run, 'git tag'), [ 'git tag @fix/a@1.1.0', 'git tag @priv/b@2.1.0' ]);

      // npm auth is still required because a public package publishes
      assert.deepEqual(commands(run, 'npm whoami'), [ 'npm whoami' ]);

      // the private package's npm registry is never consulted
      assert.deepEqual(commands(run, 'npm view'), [ 'npm view @fix/a versions --json' ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('fixed — leaves an unchanged, independent package behind', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'fixed' } },
      'packages/a': { name: '@fix/a', version: '1.4.0', scripts: { all: 'exit 0' } },
      'packages/b': { name: '@fix/b', version: '1.1.0' }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.4.0' ], '@fix/b': [ '1.1.0' ] },
      tags: [ 'v1.4.0' ],
      changes: { 'packages/a': [ 'feat: only a moved' ], 'packages/b': [] }
    });

    try {
      const result = await release({
        cwd,
        run,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'minor', yes: true })
      });

      // only the changed package is released, at the bumped shared version;
      // the untouched, unrelated package keeps its own version and is skipped
      assert.deepEqual(result.released, [ { name: '@fix/a', version: '1.5.0' } ]);
      assert.deepEqual(result.skipped, [ '@fix/b' ]);
      assert.deepEqual(result.tags, [ 'v1.5.0' ]);

      // the unchanged package is never versioned, built or published
      assert.deepEqual(commands(run, 'npm publish'), [ 'npm publish' ]);
      assert.deepEqual(commands(run, 'npm run all'), [ 'npm run all' ]);

      // its version on disk is untouched
      const b = readJSON(join(cwd, 'packages/b', 'package.json'));
      assert.equal(b.version, '1.1.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('fixed — forceRelease releases even unchanged packages together', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'fixed' } },
      'packages/a': { name: '@fix/a', version: '1.4.0', scripts: { all: 'exit 0' } },
      'packages/b': { name: '@fix/b', version: '1.4.0', scripts: { all: 'exit 0' } }
    });

    // only @fix/a has changes since the baseline; without forceRelease, @fix/b
    // would be left behind (see the test above)
    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.4.0' ], '@fix/b': [ '1.4.0' ] },
      tags: [ 'v1.4.0' ],
      changes: { 'packages/a': [ 'feat: only a moved' ], 'packages/b': [] }
    });

    try {
      const result = await release({
        cwd,
        run,
        forceRelease: true,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'minor', yes: true })
      });

      // both move together to the shared version under one tag
      assert.deepEqual(result.released, [
        { name: '@fix/a', version: '1.5.0' },
        { name: '@fix/b', version: '1.5.0' }
      ]);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(result.tags, [ 'v1.5.0' ]);
      assert.deepEqual(commands(run, 'npm version'), [
        'npm version 1.5.0 --no-git-tag-version',
        'npm version 1.5.0 --no-git-tag-version'
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('independent — forceRelease releases an untagged and an unchanged package', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0', scripts: { all: 'exit 0' } },
      'packages/b': { name: '@fix/b', version: '2.0.0', scripts: { all: 'exit 0' } }
    });

    // @fix/a is published but has no git tag — normally skipped with a warning;
    // @fix/b is tagged but unchanged — normally left behind. forceRelease
    // bypasses both the untagged skip and change detection.
    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.0.0' ], '@fix/b': [ '2.0.0' ] },
      tags: [ '@fix/b@2.0.0' ],
      changes: { 'packages/a': [], 'packages/b': [] }
    });

    try {
      const result = await release({
        cwd,
        run,
        forceRelease: true,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'minor', yes: true })
      });

      // both release under their own tags despite the missing tag / no changes
      assert.deepEqual(result.released, [
        { name: '@fix/a', version: '1.1.0' },
        { name: '@fix/b', version: '2.1.0' }
      ]);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(commands(run, 'git tag'), [ 'git tag @fix/a@1.1.0', 'git tag @fix/b@2.1.0' ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('fixed — skips the build (with no side effects) for a package without an "all" script', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'fixed' } },
      'packages/a': { name: '@app/a', version: '1.0.0', private: true },
      'packages/b': { name: '@app/b', version: '1.0.0', private: true }
    });

    const run = createRunner({
      tags: [ 'v1.0.0' ],
      changes: { 'packages/a': [ 'feat: a' ], 'packages/b': [ 'feat: b' ] }
    });

    try {
      const result = await release({
        cwd,
        run,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'minor', yes: true })
      });

      // neither package has an `all` script, so nothing is built — but both are
      // still versioned and tagged
      assert.deepEqual(commands(run, 'npm run all'), []);
      assert.deepEqual(result.released, [
        { name: '@app/a', version: '1.1.0' },
        { name: '@app/b', version: '1.1.0' }
      ]);
      assert.deepEqual(result.tags, [ 'v1.1.0' ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('fixed — build:false skips the build even when an "all" script exists', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'fixed' } },
      'packages/a': { name: '@app/a', version: '1.0.0', private: true, scripts: { all: 'exit 0' } },
      'packages/b': { name: '@app/b', version: '1.0.0', private: true, scripts: { all: 'exit 0' } }
    });

    const run = createRunner({
      tags: [ 'v1.0.0' ],
      changes: { 'packages/a': [ 'feat: a' ], 'packages/b': [ 'feat: b' ] }
    });

    try {
      const result = await release({
        cwd,
        run,
        build: false,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'minor', yes: true })
      });

      assert.deepEqual(commands(run, 'npm run all'), []);
      assert.deepEqual(result.tags, [ 'v1.1.0' ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('fixed — a shared pre-release does not drag in left-behind stable packages', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'fixed' } },
      'packages/a': { name: '@fix/a', version: '1.5.0-alpha.0' },
      'packages/b': { name: '@fix/b', version: '1.1.0' }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.5.0-alpha.0' ], '@fix/b': [ '1.1.0' ] },
      tags: [ 'v1.5.0-alpha.0' ],
      changes: { 'packages/a': [], 'packages/b': [] }
    });

    try {
      const result = await release({
        cwd,
        run,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'minor', yes: true })
      });

      // only the package already on a pre-release graduates; the stable package
      // left behind at an older version is not pulled into the pre-release train
      assert.deepEqual(result.released, [ { name: '@fix/a', version: '1.5.0' } ]);
      assert.deepEqual(result.skipped, [ '@fix/b' ]);
      assert.deepEqual(result.tags, [ 'v1.5.0' ]);

      const b = readJSON(join(cwd, 'packages/b', 'package.json'));
      assert.equal(b.version, '1.1.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('fixed — reports nothing to publish when only unchanged packages remain', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'fixed' } },
      'packages/a': { name: '@fix/a', version: '1.4.0' },
      'packages/b': { name: '@fix/b', version: '1.1.0' }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.4.0' ], '@fix/b': [ '1.1.0' ] },
      tags: [ 'v1.4.0' ],
      changes: { 'packages/a': [], 'packages/b': [] }
    });

    try {
      const result = await release({ cwd, run, logger: SILENT_LOGGER, prompter: createScriptedPrompter() });

      assert.deepEqual(result, { strategy: 'fixed', released: [], skipped: [] });
      assert.deepEqual(commands(run, 'npm publish'), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('aborts without side effects when the release is not confirmed', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.0.0' ] },
      tags: [ '@fix/a@1.0.0' ],
      changes: { 'packages/a': [ 'fix: a' ] }
    });

    try {
      const result = await release({
        cwd,
        run,
        logger: SILENT_LOGGER,
        prompter: createScriptedPrompter({ bump: 'patch', yes: false })
      });

      assert.equal(result.aborted, true);
      assert.deepEqual(result.released, []);

      // nothing destructive ran
      assert.deepEqual(commands(run, 'npm publish'), []);
      assert.deepEqual(commands(run, 'git commit'), []);
      assert.deepEqual(commands(run, 'git tag'), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('reports nothing to publish when no package changed', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' }
    });

    const run = createRunner({
      npmVersions: { '@fix/a': [ '1.0.0' ] },
      tags: [ '@fix/a@1.0.0' ],
      changes: { 'packages/a': [] }
    });

    try {
      const result = await release({ cwd, run, logger: SILENT_LOGGER, prompter: createScriptedPrompter() });

      assert.deepEqual(result, { strategy: 'independent', released: [], skipped: [] });
      assert.deepEqual(commands(run, 'npm publish'), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('pre-flight — rejects a dirty working tree', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' }
    });

    const run = createRunner({ clean: false });

    try {
      await assert.rejects(
        release({ cwd, run, logger: SILENT_LOGGER, prompter: createScriptedPrompter() }),
        (err) => err instanceof ReleaseError && /uncommitted changes/.test(err.message)
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('pre-flight — rejects when not authenticated with npm', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' }
    });

    const run = createRunner({ whoami: null });

    try {
      await assert.rejects(
        release({ cwd, run, logger: SILENT_LOGGER, prompter: createScriptedPrompter() }),
        (err) => err instanceof ReleaseError && /Not authenticated with npm/.test(err.message)
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('pre-flight — rejects a stale lockfile', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' }
    });

    // clean tree up front, but `npm install` dirties it → lockfile was stale
    const run = createRunner({ staleAfterInstall: true });

    try {
      await assert.rejects(
        release({ cwd, run, logger: SILENT_LOGGER, prompter: createScriptedPrompter() }),
        (err) => err instanceof ReleaseError && /Lockfile is out of date/.test(err.message)
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('pre-flight — rejects a global \'latest\' dist-tag up front', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'independent' } },
      'packages/a': { name: '@fix/a', version: '1.0.0' }
    });

    const run = createRunner();

    try {
      await assert.rejects(
        release({ cwd, run, distTag: 'latest', logger: SILENT_LOGGER, prompter: createScriptedPrompter() }),
        (err) => err instanceof ReleaseError && /Refusing the global 'latest' dist-tag/.test(err.message)
      );

      // rejected before any git/npm work
      assert.equal(run.calls.length, 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});


test('resolveDistTag', async (t) => {

  await t.test('defaults a stable version to the latest dist-tag', () => {
    assert.equal(resolveDistTag('1.2.3'), LATEST_DIST_TAG);
    assert.equal(resolveDistTag('1.2.3', undefined), 'latest');
  });

  await t.test('honors an explicit dist-tag for a stable version', () => {
    assert.equal(resolveDistTag('1.2.3', 'next'), 'next');
  });

  await t.test('lets a stable version publish to a non-latest tag (intended)', () => {

    // a global --dist-tag also redirects stable packages off `latest`
    assert.equal(resolveDistTag('1.2.3', 'beta'), 'beta');
  });

  await t.test('honors an explicit non-latest dist-tag for a pre-release', () => {
    assert.equal(resolveDistTag('1.3.0-alpha.0', 'next'), 'next');
    assert.equal(resolveDistTag('1.3.0-rc.2', 'rc'), 'rc');
  });

  await t.test('rejects a pre-release without a dist-tag', () => {
    assert.throws(() => resolveDistTag('1.3.0-alpha.0'), ReleaseError);
    assert.throws(() => resolveDistTag('1.3.0-alpha.0'), /requires an explicit dist-tag/);
  });

  await t.test('rejects a pre-release aimed at the latest dist-tag', () => {
    assert.throws(() => resolveDistTag('1.3.0-alpha.0', LATEST_DIST_TAG), ReleaseError);
    assert.throws(() => resolveDistTag('1.3.0-alpha.0', 'latest'), /Refusing to publish/);
  });
});
