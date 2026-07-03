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
  maxVersion
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
});


test('maxVersion', async (t) => {

  await t.test('returns the highest version', () => {
    assert.equal(maxVersion([ '1.0.0', '1.2.0', '1.1.5' ]), '1.2.0');
  });

  await t.test('defaults to 0.0.0 for empty input', () => {
    assert.equal(maxVersion([]), '0.0.0');
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
