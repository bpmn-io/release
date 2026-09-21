import opener from 'opener';

/**
 * GitHub release drafts — `np`'s post-publish step: open a pre-filled
 * "new release" page per pushed tag, for the maintainer to review and publish.
 * Best-effort: a non-GitHub remote or a failing browser open never fails the
 * release.
 */

// https://github.com/owner/repo(.git) | git@github.com:owner/repo(.git) |
// ssh://git@github.com/owner/repo(.git)
const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+?)(?:\.git)?$/;

// GitHub caps release URLs around 8k characters; stay conservative (as does np).
const URL_LENGTH_LIMIT = 7900;

/**
 * Parse a git remote URL into its GitHub `{ owner, repo }`, or `null` when the
 * remote is not hosted on github.com.
 *
 * @param {string} url git remote URL
 * @return {{ owner: string, repo: string } | null}
 */
export function parseGitHubRemote(url) {
  const match = url.trim().match(GITHUB_REMOTE);
  return match ? { owner: match[1], repo: match[2] } : null;
}

/**
 * Render the draft body `np`-style: one `- subject  hash` line per commit
 * (subjects HTML-escaped), followed by a compare footer against the previous
 * release tag. No heading, no footer when there is no previous tag.
 *
 * @param {Object} opts
 * @param {string} opts.repoUrl e.g. `https://github.com/owner/repo`
 * @param {string|null} opts.previousTag baseline tag the release is cut from
 * @param {string} opts.tag the new release tag
 * @param {Array<{ subject: string, hash?: string }>} opts.commits shipped commits
 * @return {string}
 */
export function createReleaseNotes({ repoUrl, previousTag, tag, commits }) {
  const lines = commits.map(
    ({ subject, hash }) => `- ${htmlEscape(subject)}${hash ? '  ' + hash : ''}`
  );

  let body = lines.join('\n');
  if (previousTag) {
    body += `${body ? '\n\n' : ''}---\n\n${repoUrl}/compare/${previousTag}...${tag}`;
  }

  return body;
}

const htmlEscape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Build the pre-filled "new release" URL for a tag (the `new-github-release-url`
 * primitive `np` uses).
 *
 * @param {{ owner: string, repo: string, tag: string, title?: string, body?: string, prerelease?: boolean }} draft
 * @return {string}
 */
export function createDraftUrl({ owner, repo, tag, title, body, prerelease }) {
  const url = new URL(`https://github.com/${owner}/${repo}/releases/new`);
  url.searchParams.set('tag', tag);
  url.searchParams.set('title', title ?? tag);
  if (body) url.searchParams.set('body', body);
  if (prerelease) url.searchParams.set('prerelease', '1');
  return url.toString();
}

/**
 * Open a release draft per given tag in the user's browser. Skipped (with a
 * note) when the `origin` remote is not on GitHub. On a failing browser open
 * the draft URL is printed for manual drafting.
 *
 * @param {Object} opts
 * @param {(file: string, args?: string[], opts?: object) => Promise<string>} opts.run process runner
 * @param {{ log: Function, warn: Function }} opts.logger
 * @param {Array<{ tag: string, previousTag?: string|null, commits?: Array<{ subject: string, hash?: string }>, prerelease?: boolean }>} opts.drafts
 * @param {(url: string) => void} [opts.open] browser opener (default: `opener`)
 * @return {Promise<string[]>} the draft URLs — empty when not on GitHub
 */
export async function openGitHubReleaseDrafts({ run, logger, drafts, open = opener }) {
  if (drafts.length === 0) {
    return [];
  }

  let remote;
  try {
    remote = parseGitHubRemote(await run('git', [ 'remote', 'get-url', 'origin' ]));
  } catch {
    remote = null;
  }

  if (!remote) {
    logger.log('\nNo GitHub remote detected — skipping GitHub release draft(s).');
    return [];
  }

  const urls = [];
  const repoUrl = `https://github.com/${remote.owner}/${remote.repo}`;

  for (const { tag, previousTag = null, commits = [], prerelease } of drafts) {
    const body = createReleaseNotes({ repoUrl, previousTag, tag, commits }) || undefined;

    let url = createDraftUrl({ owner: remote.owner, repo: remote.repo, tag, body, prerelease });

    // GitHub rejects overly long release URLs; rather than np's clipboard
    // dance, drop the notes and leave the body empty.
    if (body && url.length > URL_LENGTH_LIMIT) {
      url = createDraftUrl({ owner: remote.owner, repo: remote.repo, tag, prerelease });
      logger.warn(`  release notes for ${tag} too long for the draft URL — left the body empty`);
    }
    urls.push(url);

    try {
      open(url);
      logger.log(`  opened a GitHub release draft for ${tag} in your browser`);
    } catch {
      logger.warn(`  could not open a browser for ${tag} — draft the release manually:\n    ${url}`);
    }
  }

  return urls;
}
