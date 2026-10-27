import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'release.js');


// every case below fails during argument validation, before any I/O
function cli(cwd, args) {
  return new Promise(resolve => {
    execFile(process.execPath, [ BIN, ...args ], { cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}


test('bio-release --preid', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-cli-'));
  writeFileSync(join(cwd, 'package.json'), '{}\n');

  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  await t.test('refuses a stable --bump level', async () => {
    const { code, stderr } = await cli(cwd, [ '--bump', 'minor', '--preid', 'rc', '--yes' ]);

    assert.equal(code, 1);
    assert.match(stderr, /"minor" would release a stable version, but --preid rc was given/);
  });

  await t.test('refuses a stable per-package --bump', async () => {
    const { code, stderr } = await cli(cwd, [ '--bump', '@scope/a=preminor', '--bump', '@scope/b=patch', '--preid', 'rc' ]);

    assert.equal(code, 1);
    assert.match(stderr, /"patch" would release a stable version/);
  });

  await t.test('refuses an explicit pre-release of another identifier', async () => {
    const { code, stderr } = await cli(cwd, [ '--bump', '1.3.0-beta.0', '--preid', 'rc' ]);

    assert.equal(code, 1);
    assert.match(stderr, /does not use the --preid rc identifier/);
  });

  await t.test('refuses a missing value', async () => {
    const { code, stderr } = await cli(cwd, [ '--bump', 'minor', '--preid' ]);

    assert.equal(code, 1);
    assert.match(stderr, /--preid requires a value/);
  });

  await t.test('does not swallow a following flag as the value', async () => {
    const { code, stderr } = await cli(cwd, [ '--preid', '--bump', 'minor' ]);

    assert.equal(code, 1);
    assert.match(stderr, /--preid requires a value/);
  });

  await t.test('refuses a malformed value', async () => {
    const { code, stderr } = await cli(cwd, [ '--preid', 'rc.1', '--bump', 'preminor' ]);

    assert.equal(code, 1);
    assert.match(stderr, /Invalid --preid "rc\.1"/);
  });

  await t.test('prints help even with a malformed or missing value', async () => {
    for (const args of [
      [ '--help', '--preid' ],
      [ '--preid', '--help' ],
      [ '--preid', '', '--help' ],
      [ '-h', '--preid', 'r c' ]
    ]) {
      const { code, stdout } = await cli(cwd, args);

      assert.equal(code, 0, args.join(' '));
      assert.match(stdout, /^Usage: bio-release \[options\]/, args.join(' '));
    }
  });

  await t.test('refuses an empty value', async () => {
    const { code, stderr } = await cli(cwd, [ '--preid', '', '--bump', 'minor' ]);

    assert.equal(code, 1);
    assert.match(stderr, /Invalid --preid ""/);
  });
});


test('bio-release version --preid', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-cli-'));
  writeFileSync(join(cwd, 'package.json'), '{}\n');

  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  await t.test('refuses a stable version', async () => {
    const { code, stderr } = await cli(cwd, [ 'version', '1.2.3', '--preid', 'rc' ]);

    assert.equal(code, 1);
    assert.match(stderr, /1\.2\.3 is a stable version, but --preid rc was given/);
  });

  await t.test('refuses a stable level in a per-package override', async () => {
    const { code, stderr } = await cli(cwd, [ 'version', 'preminor', '@scope/a=minor', '--preid', 'rc' ]);

    assert.equal(code, 1);
    assert.match(stderr, /"minor" would release a stable version/);
  });

  await t.test('refuses a missing value', async () => {
    const { code, stderr } = await cli(cwd, [ 'version', '1.2.3', '--preid' ]);

    assert.equal(code, 1);
    assert.match(stderr, /--preid requires a value/);
  });

  await t.test('prints help even with a malformed or missing value', async () => {
    for (const args of [
      [ 'version', '--help', '--preid' ],
      [ 'version', '--preid', '--help' ],
      [ 'version', '--preid', '', '-h' ]
    ]) {
      const { code, stdout } = await cli(cwd, args);

      assert.equal(code, 0, args.join(' '));
      assert.match(stdout, /^Usage: bio-release version <spec\.\.\.>/, args.join(' '));
    }
  });
});
