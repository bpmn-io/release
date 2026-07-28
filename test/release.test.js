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
 *   clean?: boolean
 * }} [world]
 */
function createRunner({ npmVersions = {}, tags = [], changes = {}, whoami = 'ci-bot', clean = true } = {}) {
  const calls = [];

  async function run(file, args = [], opts = {}) {
    calls.push({ file, args: [ ...args ], opts, cmd: [ file, ...args ].join(' ') });

    // pre-flight: working tree status
    if (file === 'git' && args[0] === 'status') {
      return clean ? '' : ' M packages/a/index.js';
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
      'packages/a': { name: '@fix/a', version: '1.0.0' },
      'packages/c': { name: '@fix/c', version: '1.0.0', dependencies: { '@fix/a': '^1.0.0' } }
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

  await t.test('fixed — leaves an unchanged, independent package behind', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ], releaseConfig: { strategy: 'fixed' } },
      'packages/a': { name: '@fix/a', version: '1.4.0' },
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
