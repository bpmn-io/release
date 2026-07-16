import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDistTag, LATEST_DIST_TAG, ReleaseError } from '../lib/release.js';


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
