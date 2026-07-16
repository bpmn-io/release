import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PassThrough } from 'node:stream';

import { createInteractivePrompter, createScriptedPrompter } from '../lib/prompt.js';


// Drive the interactive prompter with a canned set of answer lines, feeding the
// next answer only in response to a prompt (a chunk ending in ': ') so lines are
// never emitted before `question` is listening for them.
function interactive(answers, opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const queue = [ ...answers ];

  output.on('data', chunk => {
    if (chunk.toString().endsWith(': ')) {
      const next = queue.shift();
      if (next !== undefined) input.write(`${next}\n`);
    }
  });

  return createInteractivePrompter({ input, output, ...opts });
}


test('createInteractivePrompter', async (t) => {

  await t.test('returns a stable bump without a dist-tag', async () => {
    const prompter = interactive([ 'minor' ]);

    assert.deepEqual(
      await prompter.bump({ name: '@test/a', currentVersion: '1.2.3' }),
      { type: 'minor', preid: 'alpha', distTag: undefined }
    );

    prompter.close();
  });

  await t.test('asks for identifier and dist-tag on a pre-release bump', async () => {
    const prompter = interactive([ 'preminor', 'beta', 'next' ]);

    assert.deepEqual(
      await prompter.bump({ name: '@test/a', currentVersion: '1.2.3' }),
      { type: 'preminor', preid: 'beta', distTag: 'next' }
    );

    prompter.close();
  });

  await t.test('defaults the dist-tag to the identifier', async () => {
    const prompter = interactive([ 'preminor', '', '' ]);

    assert.deepEqual(
      await prompter.bump({ name: '@test/a', currentVersion: '1.2.3' }),
      { type: 'preminor', preid: 'alpha', distTag: 'alpha' }
    );

    prompter.close();
  });

  await t.test('defaults the dist-tag to the configured one', async () => {
    const prompter = interactive([ 'preminor', 'beta', '' ], { defaultDistTag: 'next' });

    assert.deepEqual(
      await prompter.bump({ name: '@test/a', currentVersion: '1.2.3' }),
      { type: 'preminor', preid: 'beta', distTag: 'next' }
    );

    prompter.close();
  });

  await t.test('re-asks until the dist-tag is not latest', async () => {
    const prompter = interactive([ 'preminor', 'alpha', 'latest', 'next' ]);

    assert.deepEqual(
      await prompter.bump({ name: '@test/a', currentVersion: '1.2.3' }),
      { type: 'preminor', preid: 'alpha', distTag: 'next' }
    );

    prompter.close();
  });

  await t.test('returns "skip" verbatim', async () => {
    const prompter = interactive([ 'skip' ]);

    assert.equal(await prompter.bump({ name: '@test/a', currentVersion: '1.2.3' }), 'skip');

    prompter.close();
  });
});


test('createScriptedPrompter', async (t) => {

  await t.test('returns a { type, preid } decision for a stable bump', async () => {
    const prompter = createScriptedPrompter({ bump: 'minor' });

    assert.deepEqual(
      await prompter.bump({ name: '@test/a', currentVersion: '1.2.3' }),
      { type: 'minor', preid: 'alpha' }
    );
  });

  await t.test('carries the configured pre-release identifier', async () => {
    const prompter = createScriptedPrompter({ bump: 'preminor', preid: 'beta' });

    assert.deepEqual(
      await prompter.bump({ name: '@test/a', currentVersion: '1.2.3' }),
      { type: 'preminor', preid: 'beta' }
    );
  });

  await t.test('prefers a per-package bump over the default', async () => {
    const prompter = createScriptedPrompter({ bumps: { '@test/a': 'patch' }, bump: 'minor' });

    assert.deepEqual(
      await prompter.bump({ name: '@test/a', currentVersion: '1.2.3' }),
      { type: 'patch', preid: 'alpha' }
    );
    assert.deepEqual(
      await prompter.bump({ name: '@test/b', currentVersion: '1.2.3' }),
      { type: 'minor', preid: 'alpha' }
    );
  });

  await t.test('returns "skip" verbatim', async () => {
    const prompter = createScriptedPrompter({ bump: 'skip' });

    assert.equal(await prompter.bump({ name: '@test/a', currentVersion: '1.2.3' }), 'skip');
  });

  await t.test('throws on an invalid bump level', async () => {
    const prompter = createScriptedPrompter({ bump: 'mega' });

    await assert.rejects(
      () => prompter.bump({ name: '@test/a', currentVersion: '1.2.3' }),
      /No valid bump configured for "@test\/a"/
    );
  });

  await t.test('confirms according to yes', async () => {
    assert.equal(await createScriptedPrompter({ yes: true }).confirm(), true);
    assert.equal(await createScriptedPrompter({ yes: false }).confirm(), false);
    assert.equal(await createScriptedPrompter().confirm(), false);
  });
});
