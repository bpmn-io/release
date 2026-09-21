import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGitHubRemote, createDraftUrl, createReleaseNotes, openGitHubReleaseDrafts } from '../lib/github.js';


const SILENT_LOGGER = { log() {}, warn() {}, error() {} };

const GITHUB_HTTPS = 'https://github.com/bpmn-io/internal.git';


test('parseGitHubRemote', async (t) => {

  await t.test('parses https remotes, with and without .git suffix', () => {
    assert.deepEqual(parseGitHubRemote(GITHUB_HTTPS), { owner: 'bpmn-io', repo: 'internal' });
    assert.deepEqual(parseGitHubRemote('https://github.com/bpmn-io/internal'), { owner: 'bpmn-io', repo: 'internal' });
  });

  await t.test('parses ssh remotes', () => {
    assert.deepEqual(parseGitHubRemote('git@github.com:bpmn-io/internal.git'), { owner: 'bpmn-io', repo: 'internal' });
    assert.deepEqual(parseGitHubRemote('ssh://git@github.com/bpmn-io/internal.git'), { owner: 'bpmn-io', repo: 'internal' });
  });

  await t.test('returns null for non-GitHub remotes', () => {
    assert.equal(parseGitHubRemote('https://gitlab.com/bpmn-io/internal.git'), null);
    assert.equal(parseGitHubRemote('https://github.example.com/bpmn-io/internal.git'), null);
  });
});


test('createDraftUrl', async (t) => {

  await t.test('pre-fills tag, title and body', () => {
    const url = new URL(createDraftUrl({
      owner: 'bpmn-io', repo: 'internal', tag: '@fix/a@1.1.0',
      body: '## Changes\n\n* feat: something'
    }));

    assert.equal(url.origin + url.pathname, 'https://github.com/bpmn-io/internal/releases/new');
    assert.equal(url.searchParams.get('tag'), '@fix/a@1.1.0');
    assert.equal(url.searchParams.get('title'), '@fix/a@1.1.0');
    assert.equal(url.searchParams.get('body'), '## Changes\n\n* feat: something');
    assert.equal(url.searchParams.get('prerelease'), null);
  });

  await t.test('marks pre-releases', () => {
    const url = new URL(createDraftUrl({
      owner: 'bpmn-io', repo: 'internal', tag: 'v1.3.0-alpha.0', prerelease: true
    }));

    assert.equal(url.searchParams.get('prerelease'), '1');
  });
});


test('createReleaseNotes', async (t) => {
  const repoUrl = 'https://github.com/bpmn-io/internal';

  await t.test('renders np-compatible notes: bullet per commit with hash, compare footer', () => {
    const body = createReleaseNotes({
      repoUrl,
      previousTag: 'v1.0.0',
      tag: 'v1.1.0',
      commits: [
        { subject: 'feat: add thing', hash: 'abc1234' },
        { subject: 'fix: repair other', hash: 'def5678' }
      ]
    });

    assert.equal(body,
      '- feat: add thing  abc1234\n' +
      '- fix: repair other  def5678\n' +
      '\n---\n\n' +
      'https://github.com/bpmn-io/internal/compare/v1.0.0...v1.1.0'
    );
  });

  await t.test('escapes HTML in subjects', () => {
    const body = createReleaseNotes({
      repoUrl,
      previousTag: null,
      tag: 'v1.1.0',
      commits: [ { subject: 'fix: a <b> & "c"' } ]
    });

    assert.equal(body, '- fix: a &lt;b&gt; &amp; "c"');
  });

  await t.test('omits the compare footer without a previous tag', () => {
    const body = createReleaseNotes({
      repoUrl,
      previousTag: null,
      tag: 'v1.0.0',
      commits: [ { subject: 'feat: initial', hash: 'abc1234' } ]
    });

    assert.equal(body, '- feat: initial  abc1234');
  });

  await t.test('renders the compare footer even without commits', () => {
    const body = createReleaseNotes({ repoUrl, previousTag: 'v1.0.0', tag: 'v1.0.1', commits: [] });

    assert.equal(body, '---\n\nhttps://github.com/bpmn-io/internal/compare/v1.0.0...v1.0.1');
  });
});


test('openGitHubReleaseDrafts', async (t) => {

  const createRun = (remote) => {
    const calls = [];
    const run = async (file, args = []) => {
      calls.push({ file, args: [ ...args ] });
      if (file === 'git' && args[0] === 'remote') {
        if (!remote) throw new Error('no such remote');
        return remote;
      }
      return '';
    };
    run.calls = calls;
    return run;
  };

  // a browser opener recording the URLs it is asked to open
  const createOpen = ({ failing = false } = {}) => {
    const opened = [];
    const open = (url) => {
      if (failing) throw new Error('no browser');
      opened.push(url);
    };
    open.opened = opened;
    return open;
  };

  const drafts = [ { tag: 'v1.2.0', previousTag: 'v1.1.0', commits: [ { subject: 'feat: x', hash: 'abc1234' } ] } ];

  await t.test('opens a draft per tag against the detected GitHub remote', async () => {
    const run = createRun(GITHUB_HTTPS);
    const open = createOpen();
    const urls = await openGitHubReleaseDrafts({ run, logger: SILENT_LOGGER, drafts, open });

    assert.equal(urls.length, 1);
    assert.ok(urls[0].startsWith('https://github.com/bpmn-io/internal/releases/new?'));
    assert.deepEqual(open.opened, urls);

    // the draft body is the np-compatible release notes
    const body = new URL(urls[0]).searchParams.get('body');
    assert.match(body, /^- feat: x {2}abc1234/);
    assert.match(body, /\/compare\/v1\.1\.0\.\.\.v1\.2\.0$/);
  });

  await t.test('skips when the remote is not GitHub', async () => {
    const run = createRun('git@gitlab.com:bpmn-io/internal.git');
    const open = createOpen();
    const urls = await openGitHubReleaseDrafts({ run, logger: SILENT_LOGGER, drafts, open });

    assert.deepEqual(urls, []);
    assert.deepEqual(open.opened, []);
  });

  await t.test('skips when no origin remote exists', async () => {
    const run = createRun(null);
    const open = createOpen();
    const urls = await openGitHubReleaseDrafts({ run, logger: SILENT_LOGGER, drafts, open });

    assert.deepEqual(urls, []);
  });

  await t.test('a failing browser open does not throw; the URL is returned for manual drafting', async () => {
    const run = createRun(GITHUB_HTTPS);
    const open = createOpen({ failing: true });
    const urls = await openGitHubReleaseDrafts({ run, logger: SILENT_LOGGER, drafts, open });

    assert.equal(urls.length, 1);
  });

  await t.test('drops an oversized body rather than opening a rejected URL', async () => {
    const run = createRun(GITHUB_HTTPS);
    const open = createOpen();
    const longDrafts = [ {
      tag: 'v1.2.0',
      previousTag: 'v1.1.0',
      commits: Array.from({ length: 200 }, (_, i) => ({ subject: `feat: a rather long commit subject number ${i}`, hash: 'abc1234' }))
    } ];

    const urls = await openGitHubReleaseDrafts({ run, logger: SILENT_LOGGER, drafts: longDrafts, open });

    assert.equal(urls.length, 1);
    assert.ok(urls[0].length < 7900);
    assert.equal(new URL(urls[0]).searchParams.get('body'), null);
  });

  await t.test('no drafts, no work', async () => {
    const run = createRun(GITHUB_HTTPS);
    const urls = await openGitHubReleaseDrafts({ run, logger: SILENT_LOGGER, drafts: [] });

    assert.deepEqual(urls, []);
    assert.deepEqual(run.calls, []);
  });
});
