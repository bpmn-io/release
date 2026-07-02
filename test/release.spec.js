import { expect } from 'chai';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { release, ReleaseError } from '../lib/release.js';
import { createScriptedPrompter } from '../lib/prompt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'monorepo');


// ── helpers ──────────────────────────────────────────────────────────────────

async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('Expected promise to reject but it resolved');
}

const silent = { log: () => {}, warn: () => {} };

/**
 * Build a fake exec function that responds to git/npm command patterns.
 *
 * @param {Object} [opts]
 * @param {boolean}                     [opts.dirty=false]          working tree has changes
 * @param {boolean}                     [opts.authenticated=true]   npm whoami succeeds
 * @param {Object<string, string|null>} [opts.npmVersions={}]       name → latest stable (null = unpublished)
 * @param {Object<string, Object>}      [opts.distTags={}]          name → dist-tags object
 * @param {Object<string, boolean>}     [opts.hasChanges={}]        tag → whether changes exist (default true)
 */
function makeExec({
  dirty = false,
  authenticated = true,
  npmVersions = {},
  distTags = {},
  hasChanges = {}
} = {}) {
  const calls = [];

  const fn = (cmd, _opts) => {
    calls.push(cmd);

    // ── pre-flight ────────────────────────────────────────────────────────────
    if (cmd === 'git status --porcelain') return dirty ? 'M some-file.js' : '';
    if (cmd === 'npm whoami') {
      if (!authenticated) throw new Error('E401 Unauthorized');
      return 'testuser';
    }

    let m;

    // ── npm registry ──────────────────────────────────────────────────────────
    if ((m = cmd.match(/^npm view (.+) version$/))) {
      const ver = npmVersions[m[1]];
      if (ver == null) throw new Error(`E404 Not Found: ${m[1]}`);
      return ver;
    }

    if ((m = cmd.match(/^npm view (.+) dist-tags --json$/))) {
      return JSON.stringify(distTags[m[1]] ?? {});
    }

    // ── git tag existence ─────────────────────────────────────────────────────
    if ((m = cmd.match(/^git rev-parse (.+) --$/))) {
      const tag = m[1];
      const [, name, version ] = tag.match(/^(.+)@(.+)$/) ?? [];
      if (name && version) {
        const knownStable = npmVersions[name];
        if (knownStable === version) return 'abc123';
        const dt = distTags[name] ?? {};
        if (Object.values(dt).includes(version)) return 'abc123';
      }
      throw new Error(`fatal: not found '${tag}'`);
    }

    // ── git log (change detection) ────────────────────────────────────────────
    if ((m = cmd.match(/^git log (.+)\.\.HEAD(?:\s|$)/))) {
      const tag = m[1];
      // hasChanges[tag] === false means no changes; default is true (has changes)
      return hasChanges[tag] === false ? '' : 'feat: something';
    }

    // ── write operations (no-ops in tests) ───────────────────────────────────
    if (/^(git (add|commit|tag|push)|npm (version|install|run|publish))/.test(cmd)) return '';

    throw new Error(`Unexpected exec call: ${JSON.stringify(cmd)}`);
  };

  fn.calls = calls;
  fn.calledWith = (pattern) => calls.some(c => pattern.test(c));
  return fn;
}

/**
 * Create a minimal monorepo in a temp directory for tests that run executeRelease
 * (which does real file reads/writes for package.json version pinning).
 */
function makeTempMonorepo({ strategy = 'independent' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bio-release-test-'));

  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'test-monorepo',
    private: true,
    workspaces: [ 'packages/*' ],
    releaseConfig: { strategy }
  }, null, 2));

  mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'a', 'package.json'), JSON.stringify({
    name: '@test/a', version: '1.0.0'
  }, null, 2));

  mkdirSync(join(dir, 'packages', 'b'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'b', 'package.json'), JSON.stringify({
    name: '@test/b', version: '1.0.0', dependencies: { '@test/a': '^1.0.0' }
  }, null, 2));

  return dir;
}


// ── pre-flight ────────────────────────────────────────────────────────────────

describe('release() — pre-flight', function() {

  it('should throw ReleaseError when the working tree is dirty', async function() {

    // given
    const exec = makeExec({ dirty: true });
    const prompter = createScriptedPrompter({ bump: 'minor', yes: true });

    // when
    const err = await rejects(release({ cwd: FIXTURE, logger: silent, prompter, _exec: exec }));

    // then
    expect(err).to.be.instanceOf(ReleaseError);
    expect(err.message).to.include('uncommitted');
  });

  it('should throw ReleaseError when not authenticated with npm', async function() {

    // given
    const exec = makeExec({ authenticated: false });
    const prompter = createScriptedPrompter({ bump: 'minor', yes: true });

    // when
    const err = await rejects(release({ cwd: FIXTURE, logger: silent, prompter, _exec: exec }));

    // then
    expect(err).to.be.instanceOf(ReleaseError);
    expect(err.message).to.include('npm login');
  });

  it('should throw ReleaseError when releaseConfig.strategy is missing', async function() {

    // given
    const tmpDir = makeTempMonorepo();
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'no-strategy', private: true, workspaces: [ 'packages/*' ]
    }));
    const exec = makeExec();
    const prompter = createScriptedPrompter({ bump: 'minor', yes: true });

    // when
    const err = await rejects(release({ cwd: tmpDir, logger: silent, prompter, _exec: exec }));

    // then
    expect(err).to.be.instanceOf(ReleaseError);
    expect(err.message).to.include('releaseConfig.strategy');

    rmSync(tmpDir, { recursive: true, force: true });
  });

});


// ── detection ────────────────────────────────────────────────────────────────

describe('release() — change detection', function() {

  it('should skip packages with no changes since their last tag', async function() {

    // given — @test/a has no changes, @test/b depends on it so also unchanged
    const exec = makeExec({
      npmVersions: { '@test/a': '1.0.0', '@test/b': '1.0.0' },
      hasChanges: { '@test/a@1.0.0': false, '@test/b@1.0.0': false }
    });

    const capturedPlan = [];
    const prompter = {
      async bump() { return { type: 'minor', preid: undefined }; },
      async confirm({ plan }) { capturedPlan.push(...plan); return false; },
      close() {}
    };

    // when
    const result = await release({ cwd: FIXTURE, logger: silent, prompter, _exec: exec });

    // then
    expect(result.released).to.eql([]);
    expect(capturedPlan).to.have.length(0);
  });

  it('should include a package that has never been published', async function() {

    // given — @test/a is not on npm yet
    const exec = makeExec({
      npmVersions: { '@test/a': null, '@test/b': null }
    });

    const capturedPlan = [];
    const prompter = {
      async bump() { return { type: 'minor', preid: undefined }; },
      async confirm({ plan }) { capturedPlan.push(...plan); return false; },
      close() {}
    };

    // when
    await release({ cwd: FIXTURE, logger: silent, prompter, _exec: exec });

    // then
    expect(capturedPlan.map(p => p.name)).to.include('@test/a');
  });

  it('should cascade: include a dependent when its dep is being released', async function() {

    // given — only @test/a changed; @test/b has no direct changes but depends on a
    const exec = makeExec({
      npmVersions: { '@test/a': '1.0.0', '@test/b': '1.0.0' },
      hasChanges: { '@test/a@1.0.0': true, '@test/b@1.0.0': false }
    });

    const capturedPlan = [];
    const prompter = {
      async bump() { return { type: 'minor', preid: undefined }; },
      async confirm({ plan }) { capturedPlan.push(...plan); return false; },
      close() {}
    };

    // when
    await release({ cwd: FIXTURE, logger: silent, prompter, _exec: exec });

    // then
    const names = capturedPlan.map(p => p.name);
    expect(names).to.include('@test/a');
    expect(names).to.include('@test/b');
  });

  it('should use a prerelease dist-tag as the change-detection baseline', async function() {

    // given — @test/a stable is 1.0.0 but an alpha exists at 1.1.0-alpha.0
    const exec = makeExec({
      npmVersions: { '@test/a': '1.0.0', '@test/b': '1.0.0' },
      distTags: { '@test/a': { latest: '1.0.0', alpha: '1.1.0-alpha.0' } },
      hasChanges: { '@test/a@1.1.0-alpha.0': true, '@test/b@1.0.0': false }
    });

    const capturedVersions = {};
    const prompter = {
      async bump({ name, currentVersion }) {
        capturedVersions[name] = currentVersion;
        return { type: 'prerelease', preid: 'alpha' };
      },
      async confirm() { return false; },
      close() {}
    };

    // when
    await release({ cwd: FIXTURE, logger: silent, prompter, _exec: exec });

    // then — @test/a's baseline is the alpha dist-tag, not the stable version
    expect(capturedVersions['@test/a']).to.equal('1.1.0-alpha.0');
  });

  it('should abort and return aborted: true when confirm returns false', async function() {

    // given
    const exec = makeExec({
      npmVersions: { '@test/a': '1.0.0', '@test/b': '1.0.0' }
    });
    const prompter = createScriptedPrompter({ bump: 'minor', yes: false });

    // when
    const result = await release({ cwd: FIXTURE, logger: silent, prompter, _exec: exec });

    // then
    expect(result.aborted).to.be.true;
    expect(result.released).to.eql([]);
  });

});


// ── execution ─────────────────────────────────────────────────────────────────

describe('release() — execution', function() {

  let tmpDir;

  afterEach(function() {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('should publish a stable release without a dist-tag', async function() {

    // given
    tmpDir = makeTempMonorepo();
    const exec = makeExec({
      npmVersions: { '@test/a': '1.0.0', '@test/b': '1.0.0' },
      hasChanges: { '@test/a@1.0.0': true, '@test/b@1.0.0': false }
    });
    const prompter = createScriptedPrompter({ bump: 'minor', yes: true });

    // when
    const result = await release({ cwd: tmpDir, logger: silent, prompter, _exec: exec });

    // then
    expect(result.released).to.deep.include({ name: '@test/a', version: '1.1.0' });
    expect(exec.calledWith(/^npm publish$/)).to.be.true;
    expect(exec.calledWith(/npm publish --tag/)).to.be.false;
  });

  it('should publish a prerelease with --tag derived from the version', async function() {

    // given
    tmpDir = makeTempMonorepo();
    const exec = makeExec({
      npmVersions: { '@test/a': '1.0.0', '@test/b': '1.0.0' },
      hasChanges: { '@test/a@1.0.0': true, '@test/b@1.0.0': false }
    });
    const prompter = createScriptedPrompter({ bump: 'preminor', preid: 'alpha', yes: true });

    // when
    const result = await release({ cwd: tmpDir, logger: silent, prompter, _exec: exec });

    // then
    expect(result.released).to.deep.include({ name: '@test/a', version: '1.1.0-alpha.0' });
    expect(exec.calledWith(/^npm publish --tag alpha$/)).to.be.true;
  });

  it('should increment an existing alpha and publish with --tag alpha', async function() {

    // given
    tmpDir = makeTempMonorepo();
    const exec = makeExec({
      npmVersions: { '@test/a': '1.0.0', '@test/b': '1.0.0' },
      distTags: { '@test/a': { latest: '1.0.0', alpha: '1.1.0-alpha.0' } },
      hasChanges: { '@test/a@1.1.0-alpha.0': true, '@test/b@1.0.0': false }
    });
    const prompter = createScriptedPrompter({ bump: 'prerelease', preid: 'alpha', yes: true });

    // when
    const result = await release({ cwd: tmpDir, logger: silent, prompter, _exec: exec });

    // then
    expect(result.released).to.deep.include({ name: '@test/a', version: '1.1.0-alpha.1' });
    expect(exec.calledWith(/^npm publish --tag alpha$/)).to.be.true;
  });

  it('should create a git tag per released package (independent strategy)', async function() {

    // given
    tmpDir = makeTempMonorepo();
    const exec = makeExec({
      npmVersions: { '@test/a': '1.0.0', '@test/b': '1.0.0' },
      hasChanges: { '@test/a@1.0.0': true, '@test/b@1.0.0': false }
    });
    const prompter = createScriptedPrompter({ bump: 'minor', yes: true });

    // when
    const result = await release({ cwd: tmpDir, logger: silent, prompter, _exec: exec });

    // then
    expect(result.tags).to.include('@test/a@1.1.0');
    expect(exec.calledWith(/^git tag @test\/a@1\.1\.0$/)).to.be.true;
  });

  it('should create a single shared tag for the fixed strategy', async function() {

    // given
    tmpDir = makeTempMonorepo({ strategy: 'fixed' });
    const exec = makeExec({
      npmVersions: { '@test/a': '1.0.0', '@test/b': '1.0.0' },
      hasChanges: { '@test/a@1.0.0': true, '@test/b@1.0.0': true }
    });
    const prompter = createScriptedPrompter({ bump: 'minor', yes: true });

    // when
    const result = await release({ cwd: tmpDir, logger: silent, prompter, _exec: exec });

    // then
    expect(result.tags).to.eql([ 'v1.1.0' ]);
  });

  it('should push the release commit and all tags to the remote', async function() {

    // given
    tmpDir = makeTempMonorepo();
    const exec = makeExec({
      npmVersions: { '@test/a': '1.0.0', '@test/b': '1.0.0' },
      hasChanges: { '@test/a@1.0.0': true, '@test/b@1.0.0': false }
    });
    const prompter = createScriptedPrompter({ bump: 'patch', yes: true });

    // when
    await release({ cwd: tmpDir, logger: silent, prompter, _exec: exec });

    // then
    expect(exec.calledWith(/^git push origin HEAD$/)).to.be.true;
    expect(exec.calledWith(/^git push origin @test\/a@/)).to.be.true;
  });

});
