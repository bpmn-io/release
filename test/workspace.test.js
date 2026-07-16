import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  readJSON,
  discoverPackages,
  topoSort,
  bumpVersion,
  compareVersions,
  maxVersion,
  parseVersion,
  isPrerelease
} from '../lib/workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_FIXTURE = join(__dirname, 'fixtures', 'workspace');


test('bumpVersion', async (t) => {

  await t.test('bumps major', () => {
    assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  });

  await t.test('bumps minor', () => {
    assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  });

  await t.test('bumps patch', () => {
    assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  });

  await t.test('throws on unknown bump', () => {
    assert.throws(() => bumpVersion('1.2.3', 'mega'), /unknown bump type: mega/);
  });

  await t.test('starts a pre-release with premajor/preminor/prepatch', () => {
    assert.equal(bumpVersion('1.2.3', 'premajor', 'alpha'), '2.0.0-alpha.0');
    assert.equal(bumpVersion('1.2.3', 'preminor', 'alpha'), '1.3.0-alpha.0');
    assert.equal(bumpVersion('1.2.3', 'prepatch', 'alpha'), '1.2.4-alpha.0');
  });

  await t.test('defaults the pre-release identifier to alpha', () => {
    assert.equal(bumpVersion('1.2.3', 'preminor'), '1.3.0-alpha.0');
  });

  await t.test('honors a custom pre-release identifier', () => {
    assert.equal(bumpVersion('1.2.3', 'preminor', 'beta'), '1.3.0-beta.0');
    assert.equal(bumpVersion('1.2.3', 'preminor', 'rc'), '1.3.0-rc.0');
  });

  await t.test('iterates a matching pre-release', () => {
    assert.equal(bumpVersion('1.3.0-alpha.0', 'prerelease', 'alpha'), '1.3.0-alpha.1');
    assert.equal(bumpVersion('1.3.0-alpha.5', 'prerelease', 'alpha'), '1.3.0-alpha.6');
  });

  await t.test('restarts numbering when the identifier changes', () => {
    assert.equal(bumpVersion('1.3.0-alpha.4', 'prerelease', 'beta'), '1.3.0-beta.0');
  });

  await t.test('starts a pre-release from a stable version via prerelease', () => {
    assert.equal(bumpVersion('1.2.3', 'prerelease', 'alpha'), '1.2.4-alpha.0');
  });

  await t.test('graduates a pre-release with a plain bump', () => {
    assert.equal(bumpVersion('1.3.0-alpha.2', 'patch'), '1.3.0');
    assert.equal(bumpVersion('1.3.0-alpha.2', 'minor'), '1.3.0');
    assert.equal(bumpVersion('1.3.0-alpha.2', 'major'), '2.0.0');
    assert.equal(bumpVersion('2.0.0-alpha.0', 'major'), '2.0.0');
    assert.equal(bumpVersion('1.2.4-alpha.0', 'patch'), '1.2.4');
  });
});


test('parseVersion', async (t) => {

  await t.test('parses a stable version', () => {
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  await t.test('parses a pre-release version', () => {
    assert.deepEqual(parseVersion('1.3.0-alpha.0'), { major: 1, minor: 3, patch: 0, prerelease: [ 'alpha', 0 ] });
  });

  await t.test('tolerates a leading v', () => {
    assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  await t.test('throws on an invalid version', () => {
    assert.throws(() => parseVersion('not.a.version'), /invalid version/);
  });
});


test('isPrerelease', async (t) => {

  await t.test('detects pre-releases', () => {
    assert.equal(isPrerelease('1.3.0-alpha.0'), true);
    assert.equal(isPrerelease('1.3.0-rc.2'), true);
  });

  await t.test('returns false for stable versions', () => {
    assert.equal(isPrerelease('1.3.0'), false);
  });
});


test('compareVersions', async (t) => {

  await t.test('orders a < b', () => {
    assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
    assert.ok(compareVersions('1.0.0', '1.1.0') < 0);
    assert.ok(compareVersions('1.0.0', '2.0.0') < 0);
  });

  await t.test('orders a > b', () => {
    assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
  });

  await t.test('detects equality', () => {
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  await t.test('orders a pre-release below its stable release', () => {
    assert.ok(compareVersions('1.3.0-alpha.0', '1.3.0') < 0);
    assert.ok(compareVersions('1.3.0', '1.3.0-alpha.0') > 0);
  });

  await t.test('orders pre-releases of the same version', () => {
    assert.ok(compareVersions('1.3.0-alpha.0', '1.3.0-alpha.1') < 0);
    assert.ok(compareVersions('1.3.0-alpha.9', '1.3.0-beta.0') < 0);
  });

  await t.test('treats matching pre-releases as equal', () => {
    assert.equal(compareVersions('1.3.0-alpha.1', '1.3.0-alpha.1'), 0);
  });
});


test('maxVersion', async (t) => {

  await t.test('returns the highest version', () => {
    assert.equal(maxVersion([ '1.0.0', '1.2.0', '1.1.5' ]), '1.2.0');
  });

  await t.test('defaults to 0.0.0 for empty input', () => {
    assert.equal(maxVersion([]), '0.0.0');
  });

  await t.test('picks a pre-release over the lower stable release', () => {
    assert.equal(maxVersion([ '1.2.3', '1.3.0-alpha.0' ]), '1.3.0-alpha.0');
  });

  await t.test('prefers the stable release over its own pre-release', () => {
    assert.equal(maxVersion([ '1.3.0-alpha.0', '1.3.0' ]), '1.3.0');
  });
});


test('topoSort', async (t) => {

  await t.test('orders dependencies before dependents', () => {
    const packages = [
      { name: 'c', pkg: { dependencies: { b: '^1.0.0' } } },
      { name: 'b', pkg: { dependencies: { a: '^1.0.0' } } },
      { name: 'a', pkg: {} }
    ];

    const ordered = topoSort(packages).map(p => p.name);

    assert.ok(ordered.indexOf('a') < ordered.indexOf('b'));
    assert.ok(ordered.indexOf('b') < ordered.indexOf('c'));
  });

  await t.test('considers devDependencies and peerDependencies', () => {
    const packages = [
      { name: 'app', pkg: { devDependencies: { lib: '^1.0.0' } } },
      { name: 'lib', pkg: {} }
    ];

    const ordered = topoSort(packages).map(p => p.name);

    assert.deepEqual(ordered, [ 'lib', 'app' ]);
  });

  await t.test('ignores edges to non-workspace packages', () => {
    const packages = [
      { name: 'a', pkg: { dependencies: { 'some-external': '^1.0.0' } } }
    ];

    assert.deepEqual(topoSort(packages).map(p => p.name), [ 'a' ]);
  });

  await t.test('throws on a dependency cycle', () => {
    const packages = [
      { name: 'a', pkg: { dependencies: { b: '^1.0.0' } } },
      { name: 'b', pkg: { dependencies: { a: '^1.0.0' } } }
    ];

    assert.throws(() => topoSort(packages), /dependency cycle detected/);
  });
});


test('discoverPackages', async (t) => {

  const rootPkg = readJSON(join(WORKSPACE_FIXTURE, 'package.json'));

  await t.test('discovers non-private workspace packages', () => {
    const packages = discoverPackages(WORKSPACE_FIXTURE, rootPkg);

    assert.deepEqual(packages.map(p => p.name), [ '@fix/a', '@fix/c' ]);
  });

  await t.test('skips private packages', () => {
    const packages = discoverPackages(WORKSPACE_FIXTURE, rootPkg);

    assert.ok(!packages.some(p => p.name === '@fix/b'));
  });

  await t.test('returns the workspace-relative dir', () => {
    const packages = discoverPackages(WORKSPACE_FIXTURE, rootPkg);
    const a = packages.find(p => p.name === '@fix/a');

    assert.equal(a.dir, join('packages', 'a'));
  });

  await t.test('warns on unsupported negated patterns', () => {
    const warnings = [];
    const logger = { warn: msg => warnings.push(msg) };

    discoverPackages(WORKSPACE_FIXTURE, { workspaces: [ '!packages/a' ] }, logger);

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /negated workspace pattern/);
  });
});
