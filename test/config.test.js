import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReleaseError } from '../lib/error.js';

import {
  resolveStrategy,
  resolveCommitMessage
} from '../lib/config.js';


test('resolveStrategy', async (t) => {

  await t.test('returns the configured strategy', () => {
    assert.equal(resolveStrategy({ releaseConfig: { strategy: 'fixed' } }), 'fixed');
    assert.equal(resolveStrategy({ releaseConfig: { strategy: 'independent' } }), 'independent');
  });

  await t.test('throws when strategy is missing', () => {
    assert.throws(() => resolveStrategy({}), ReleaseError);
    assert.throws(() => resolveStrategy({ releaseConfig: {} }), /Missing required `releaseConfig.strategy`/);
  });

  await t.test('throws on an invalid strategy', () => {
    assert.throws(
      () => resolveStrategy({ releaseConfig: { strategy: 'rolling' } }),
      /Invalid release strategy "rolling"/
    );
  });
});


test('resolveCommitMessage', async (t) => {

  await t.test('defaults for the independent strategy', () => {
    assert.equal(
      resolveCommitMessage({}, 'independent'),
      'chore(packages): release'
    );
  });

  await t.test('default for the fixed strategy includes the version placeholder', () => {
    assert.equal(
      resolveCommitMessage({}, 'fixed'),
      'chore(packages): release %version'
    );
  });

  await t.test('returns a configured message verbatim', () => {
    assert.equal(
      resolveCommitMessage({ releaseConfig: { commitMessage: 'ship it' } }, 'independent'),
      'ship it'
    );
  });

  await t.test('allows %version for the fixed strategy', () => {
    assert.equal(
      resolveCommitMessage({ releaseConfig: { commitMessage: 'release %version' } }, 'fixed'),
      'release %version'
    );
  });

  await t.test('rejects %version for the independent strategy', () => {
    assert.throws(
      () => resolveCommitMessage({ releaseConfig: { commitMessage: 'release %version' } }, 'independent'),
      /may not use `%version` unless the release strategy is "fixed"/
    );
  });

  await t.test('rejects a non-string message', () => {
    assert.throws(
      () => resolveCommitMessage({ releaseConfig: { commitMessage: 42 } }, 'fixed'),
      /expected a non-empty string/
    );
  });

  await t.test('rejects an empty / whitespace-only message', () => {
    assert.throws(
      () => resolveCommitMessage({ releaseConfig: { commitMessage: '   ' } }, 'fixed'),
      /expected a non-empty string/
    );
  });
});
