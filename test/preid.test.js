import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReleaseError } from '../lib/error.js';

import { assertPreid, assertPreidSpecs, preidConflict } from '../lib/preid.js';


test('assertPreid', async (t) => {

  await t.test('accepts semver pre-release identifiers', () => {
    for (const preid of [ 'alpha', 'beta', 'rc', 'next', 'nightly-2', 'rc1', '0', '1', '10', '0a' ]) {
      assert.doesNotThrow(() => assertPreid(preid), preid);
    }
  });

  await t.test('rejects a missing value', () => {
    assert.throws(() => assertPreid(undefined), /--preid requires a value/);
  });

  await t.test('rejects empty, flag-like and malformed values, and leading-zero numbers', () => {
    for (const preid of [ '', '--bump', '-rc', 'rc.1', 'r c', 42, '01', '007' ]) {
      assert.throws(() => assertPreid(preid), err => err instanceof ReleaseError && /Invalid --preid/.test(err.message), String(preid));
    }
  });
});


test('preidConflict', async (t) => {

  await t.test('is a no-op without a governed identifier', () => {
    for (const spec of [ 'patch', 'minor', 'major', '1.2.3', 'preminor', 'skip' ]) {
      assert.equal(preidConflict(spec, undefined), undefined, spec);
    }
  });

  await t.test('allows pre* levels and skip', () => {
    for (const spec of [ 'premajor', 'preminor', 'prepatch', 'prerelease', 'skip' ]) {
      assert.equal(preidConflict(spec, 'rc'), undefined, spec);
    }
  });

  await t.test('allows an explicit pre-release carrying the identifier', () => {
    assert.equal(preidConflict('1.3.0-rc.0', 'rc'), undefined);
    assert.equal(preidConflict('1.3.0-rc.12', 'rc'), undefined);
    assert.equal(preidConflict('1.3.0-rc', 'rc'), undefined);
  });

  await t.test('refuses stable levels', () => {
    for (const spec of [ 'patch', 'minor', 'major' ]) {
      assert.match(preidConflict(spec, 'rc'), new RegExp(`"${spec}" would release a stable version, but --preid rc was given`), spec);
    }
  });

  await t.test('refuses an explicit stable version', () => {
    assert.match(preidConflict('1.3.0', 'rc'), /1\.3\.0 is a stable version, but --preid rc was given/);
  });

  await t.test('refuses an explicit pre-release of another identifier', () => {
    assert.match(preidConflict('1.3.0-beta.2', 'rc'), /1\.3\.0-beta\.2 does not use the --preid rc identifier/);
    assert.match(preidConflict('1.3.0-rc2.0', 'rc'), /does not use the --preid rc identifier/);
  });

  await t.test('leaves unrecognised specs to the caller', () => {
    assert.equal(preidConflict('mega', 'rc'), undefined);
  });
});


test('assertPreidSpecs', async (t) => {

  await t.test('throws a ReleaseError on the first conflicting spec', () => {
    assert.throws(
      () => assertPreidSpecs([ 'preminor', 'minor' ], 'rc'),
      err => err instanceof ReleaseError && /"minor" would release a stable version/.test(err.message)
    );
  });

  await t.test('ignores undefined specs and passes valid ones', () => {
    assert.doesNotThrow(() => assertPreidSpecs([ undefined, 'preminor', '1.3.0-rc.0', 'skip' ], 'rc'));
  });

  await t.test('is a no-op without a governed identifier', () => {
    assert.doesNotThrow(() => assertPreidSpecs([ 'minor', '1.2.3' ], undefined));
  });
});
