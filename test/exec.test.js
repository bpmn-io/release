import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRun } from '../lib/exec.js';

let cwd;
let run;

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'release-exec-'));
  run = createRun(cwd);

  await run('git', [ 'init' ]);
  await run('git', [ 'config', 'user.email', 'test@example.com' ]);
  await run('git', [ 'config', 'user.name', 'Test' ]);
  await run('git', [ 'commit', '--allow-empty', '-m', 'init' ]);
});

after(async () => {
  await rm(cwd, { recursive: true, force: true });
});


test('createRun', async (t) => {

  await t.test('returns trimmed stdout', async () => {
    const out = await run('git', [ 'rev-parse', '--abbrev-ref', 'HEAD' ]);

    assert.equal(out, out.trim());
    assert.ok(out.length > 0);
  });

  await t.test('rejects on command failure', async () => {
    await assert.rejects(run('git', [ 'rev-parse', 'v9.9.9-does-not-exist', '--' ]));
  });

  await t.test('passes arguments explicitly, without a shell (no injection)', async () => {

    // A message packed with shell metacharacters; if it ever hit a shell these
    // would create files / execute commands. Passed as an explicit argument, it
    // must be stored verbatim and execute nothing.
    const message = 'chore(packages): release v1.0.0 "$(touch PWNED)" `touch PWNED2`; touch PWNED3';

    await run('git', [ 'commit', '--allow-empty', '-m', message ]);

    const subject = await run('git', [ 'log', '-1', '--pretty=format:%s' ]);
    assert.equal(subject, message);

    assert.equal(await exists(join(cwd, 'PWNED')), false);
    assert.equal(await exists(join(cwd, 'PWNED2')), false);
    assert.equal(await exists(join(cwd, 'PWNED3')), false);
  });

  await t.test('handles arguments containing spaces as a single value', async () => {
    const dir = 'sp ace';
    await mkdir(join(cwd, dir), { recursive: true });
    await writeFile(join(cwd, dir, 'file.txt'), 'hello');

    await run('git', [ 'add', join(dir, 'file.txt') ]);
    const staged = await run('git', [ 'diff', '--cached', '--name-only' ]);

    assert.ok(staged.split('\n').includes('sp ace/file.txt'));
  });
});
