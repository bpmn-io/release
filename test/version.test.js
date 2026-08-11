import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJSON } from '../lib/workspace.js';

import { setVersion, ReleaseError } from '../lib/version.js';


const SILENT_LOGGER = { log() {}, warn() {}, error() {} };

/**
 * Materialize a throwaway workspace on disk. `pkgs` maps a workspace-relative
 * directory (`''` for the repo root) to the `package.json` written there.
 *
 * @param {Record<string, object>} pkgs
 * @return {string} the workspace root (caller is responsible for cleanup)
 */
function createWorkspace(pkgs) {
  const cwd = mkdtempSync(join(tmpdir(), 'version-e2e-'));

  for (const [ rel, content ] of Object.entries(pkgs)) {
    const dir = join(cwd, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(content, null, 2) + '\n');
  }

  return cwd;
}

/**
 * A fake process runner that records every call. `npm version` mutates the
 * package.json on disk (as the real npm would), so `setVersion` and the tests
 * observe the same files.
 */
function createRunner() {
  const calls = [];

  async function run(file, args = [], opts = {}) {
    calls.push({ file, args: [ ...args ], opts, cmd: [ file, ...args ].join(' ') });

    if (file === 'npm' && args[0] === 'version') {
      const version = args[1];
      const pkgPath = join(opts.cwd, 'package.json');
      const pkg = readJSON(pkgPath);
      pkg.version = version;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      return `v${version}`;
    }

    return '';
  }

  run.calls = calls;
  return run;
}

const commands = (run, prefix) => run.calls.filter(c => c.cmd.startsWith(prefix)).map(c => c.cmd);


test('setVersion', async (t) => {

  await t.test('stamps an explicit version on all packages, including private', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ] },
      'packages/a': { name: '@fix/a', version: '1.0.0' },
      'packages/b': { name: '@fix/b', version: '1.0.0', private: true }
    });

    const run = createRunner();

    try {
      const result = await setVersion('1.2.0-nightly.0', { cwd, run, logger: SILENT_LOGGER });

      assert.deepEqual(result, [
        { name: '@fix/a', version: '1.2.0-nightly.0' },
        { name: '@fix/b', version: '1.2.0-nightly.0' }
      ]);

      // every package (incl. private) got stamped, npm install ran once
      assert.deepEqual(commands(run, 'npm version'), [
        'npm version 1.2.0-nightly.0 --no-git-tag-version',
        'npm version 1.2.0-nightly.0 --no-git-tag-version'
      ]);
      assert.deepEqual(commands(run, 'npm install'), [ 'npm install' ]);

      // no git, no publish, no whoami
      assert.deepEqual(commands(run, 'git'), []);
      assert.deepEqual(commands(run, 'npm publish'), []);
      assert.deepEqual(commands(run, 'npm whoami'), []);

      // versions stamped on disk
      assert.equal(readJSON(join(cwd, 'packages/a', 'package.json')).version, '1.2.0-nightly.0');
      assert.equal(readJSON(join(cwd, 'packages/b', 'package.json')).version, '1.2.0-nightly.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('excludePrivate leaves private packages untouched', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ] },
      'packages/a': { name: '@fix/a', version: '1.0.0' },
      'packages/b': { name: '@fix/b', version: '1.0.0', private: true }
    });

    const run = createRunner();

    try {
      const result = await setVersion('2.0.0', { cwd, run, logger: SILENT_LOGGER, excludePrivate: true });

      assert.deepEqual(result, [ { name: '@fix/a', version: '2.0.0' } ]);

      // only the public package was stamped
      assert.deepEqual(commands(run, 'npm version'), [ 'npm version 2.0.0 --no-git-tag-version' ]);

      assert.equal(readJSON(join(cwd, 'packages/a', 'package.json')).version, '2.0.0');
      assert.equal(readJSON(join(cwd, 'packages/b', 'package.json')).version, '1.0.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('pins internal workspace dependency ranges to ^<version>', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ] },
      'packages/a': { name: '@fix/a', version: '1.0.0' },
      'packages/b': {
        name: '@fix/b',
        version: '1.0.0',
        dependencies: { '@fix/a': '^1.0.0', 'lodash': '^4.0.0' }
      }
    });

    const run = createRunner();

    try {
      await setVersion('1.5.0', { cwd, run, logger: SILENT_LOGGER });

      const b = readJSON(join(cwd, 'packages/b', 'package.json'));

      // internal dep pinned, external dep untouched
      assert.equal(b.dependencies['@fix/a'], '^1.5.0');
      assert.equal(b.dependencies['lodash'], '^4.0.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('rejects an invalid version and mutates nothing', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ] },
      'packages/a': { name: '@fix/a', version: '1.0.0' }
    });

    const run = createRunner();

    try {
      await assert.rejects(
        () => setVersion('not-a-version', { cwd, run, logger: SILENT_LOGGER }),
        ReleaseError
      );

      // nothing ran, nothing changed on disk
      assert.deepEqual(run.calls, []);
      assert.equal(readJSON(join(cwd, 'packages/a', 'package.json')).version, '1.0.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('resolves a bump level against each package current version', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ] },
      'packages/a': { name: '@fix/a', version: '1.0.0' },
      'packages/b': { name: '@fix/b', version: '2.3.4' }
    });

    const run = createRunner();

    try {
      const result = await setVersion('minor', { cwd, run, logger: SILENT_LOGGER });

      assert.deepEqual(result, [
        { name: '@fix/a', version: '1.1.0' },
        { name: '@fix/b', version: '2.4.0' }
      ]);

      assert.equal(readJSON(join(cwd, 'packages/a', 'package.json')).version, '1.1.0');
      assert.equal(readJSON(join(cwd, 'packages/b', 'package.json')).version, '2.4.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('skips the stamp for a package already at its target version', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ] },
      'packages/a': { name: '@fix/a', version: '1.0.0' },
      'packages/b': { name: '@fix/b', version: '2.0.0' }
    });

    const run = createRunner();

    try {

      // target 2.0.0: @fix/a moves, @fix/b is already there
      const result = await setVersion('2.0.0', { cwd, run, logger: SILENT_LOGGER });

      assert.deepEqual(result, [
        { name: '@fix/a', version: '2.0.0' },
        { name: '@fix/b', version: '2.0.0' }
      ]);

      // only the package that actually changes is stamped — no partial mutation,
      // no "Version not changed" throw from npm
      assert.deepEqual(commands(run, 'npm version'), [ 'npm version 2.0.0 --no-git-tag-version' ]);
      assert.deepEqual(commands(run, 'npm install'), [ 'npm install' ]);

      // both end at the target on disk
      assert.equal(readJSON(join(cwd, 'packages/a', 'package.json')).version, '2.0.0');
      assert.equal(readJSON(join(cwd, 'packages/b', 'package.json')).version, '2.0.0');

      // still no git / publish
      assert.deepEqual(commands(run, 'git'), []);
      assert.deepEqual(commands(run, 'npm publish'), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('applies per-package overrides and leaves the rest untouched', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ] },
      'packages/a': { name: '@fix/a', version: '1.0.0' },
      'packages/b': { name: '@fix/b', version: '1.0.0' },
      'packages/c': { name: '@fix/c', version: '1.0.0' }
    });

    const run = createRunner();

    try {

      // no default spec: only the named packages are stamped
      const result = await setVersion(undefined, {
        cwd, run, logger: SILENT_LOGGER,
        overrides: { '@fix/a': '1.2.3', '@fix/b': 'minor' }
      });

      assert.deepEqual(result, [
        { name: '@fix/a', version: '1.2.3' },
        { name: '@fix/b', version: '1.1.0' }
      ]);

      assert.deepEqual(commands(run, 'npm version'), [
        'npm version 1.2.3 --no-git-tag-version',
        'npm version 1.1.0 --no-git-tag-version'
      ]);

      assert.equal(readJSON(join(cwd, 'packages/a', 'package.json')).version, '1.2.3');
      assert.equal(readJSON(join(cwd, 'packages/b', 'package.json')).version, '1.1.0');

      // untouched
      assert.equal(readJSON(join(cwd, 'packages/c', 'package.json')).version, '1.0.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  await t.test('rejects an override naming an unknown package', async () => {
    const cwd = createWorkspace({
      '': { private: true, workspaces: [ 'packages/*' ] },
      'packages/a': { name: '@fix/a', version: '1.0.0' }
    });

    const run = createRunner();

    try {
      await assert.rejects(
        () => setVersion(undefined, { cwd, run, logger: SILENT_LOGGER, overrides: { '@fix/nope': '1.2.3' } }),
        ReleaseError
      );

      assert.deepEqual(run.calls, []);
      assert.equal(readJSON(join(cwd, 'packages/a', 'package.json')).version, '1.0.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
