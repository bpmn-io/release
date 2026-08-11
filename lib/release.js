import { join } from 'node:path';

import {
  readJSON,
  discoverPackages,
  topoSort,
  maxVersion,
  isPrerelease
} from './workspace.js';

import { applyVersions, resolveVersion } from './version.js';

import { createRun } from './exec.js';

import { ReleaseError } from './error.js';

import {
  resolveStrategy,
  resolveCommitMessage,
  VERSION_PLACEHOLDER
} from './config.js';

import { createInteractivePrompter } from './prompt.js';

export { ReleaseError } from './error.js';

// Opinionated, fixed policy (kept as constants for now; future option surface).
const BUILD_SCRIPT = 'all';
const REMOTE = 'origin';

// A pre-release must never land on `latest` (so a plain `npm install` never
// resolves it) — and its dist-tag is never guessed: the caller must say so.
export const LATEST_DIST_TAG = 'latest';

/**
 * Resolve (and validate) the npm dist-tag a version publishes under.
 *
 * A stable version defaults to `latest` when no tag is given. A pre-release is
 * never defaulted and never allowed onto `latest`: it requires an explicit,
 * non-`latest` dist-tag, otherwise a `ReleaseError` is thrown. This is the
 * single gate that keeps pre-releases off a plain `npm install`.
 *
 * @param {string} version version being published (e.g. `1.3.0-alpha.0`)
 * @param {string} [distTag] requested dist-tag
 * @return {string} the dist-tag to publish under
 */
export function resolveDistTag(version, distTag) {
  if (isPrerelease(version)) {
    if (!distTag) {
      throw new ReleaseError(
        `Pre-release ${version} requires an explicit dist-tag; pass --dist-tag <tag> (e.g. next). ` +
        `Pre-releases are never published to '${LATEST_DIST_TAG}'.`
      );
    }
    if (distTag === LATEST_DIST_TAG) {
      throw new ReleaseError(
        `Refusing to publish pre-release ${version} to the '${LATEST_DIST_TAG}' dist-tag. ` +
        'Pre-releases must use a non-latest dist-tag (e.g. --dist-tag next).'
      );
    }
    return distTag;
  }

  return distTag ?? LATEST_DIST_TAG;
}

/**
 * Publish changed packages of an npm monorepo to npm in dependency order.
 *
 * Phase 0 — Pre-flight: validate prerequisites are met.
 * Phase 1 — Detect:     find packages with changes since their last release.
 * Phase 2 — Plan:       choose a semver bump per package (or skip).
 * Phase 3 — Execute:    apply every bump in one commit, then publish and tag.
 *
 * Versions are computed once and applied together (lerna-style): a single
 * `chore(packages): release` commit bumps the libraries, and every released
 * library is tagged against that one commit.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] repository root (default: process.cwd())
 * @param {Console} [options.logger] log sink (default: console)
 * @param {Object} [options.prompter] decision frontend (default: interactive)
 * @param {string} [options.distTag] npm dist-tag to publish under. Defaults to
 *   `latest` for stable versions. A pre-release has no default and may never be
 *   published to `latest` — it requires an explicit, non-latest dist-tag.
 * @param {boolean} [options.excludePrivate] leave private packages out of the
 *   release entirely. By default private packages are versioned, committed and
 *   tagged like any other package, but never published to the registry
 *   (default: false).
 * @param {boolean} [options.forceRelease] release every eligible package,
 *   bypassing change detection. Useful for a monorepo whose packages must
 *   always move together (default: false).
 * @param {boolean} [options.build] run each package's `all` script (build +
 *   test) before publishing/tagging. When false, the build is skipped entirely.
 *   A package without an `all` script is always skipped, with a warning
 *   (default: true).
 * @param {(file: string, args?: string[], opts?: object) => Promise<string>} [options.run]
 *   process runner used for every git/npm invocation, resolving with the
 *   command's trimmed stdout (default: a `nano-spawn` runner scoped to `cwd`).
 *   Every external call funnels through this single seam, so injecting a fake
 *   runner drives `release()` end-to-end without touching git or npm.
 *
 * @return {Promise<{
 *   strategy: string,
 *   released: Array<{ name: string, version: string }>,
 *   skipped: string[],
 *   aborted?: boolean,
 *   tags?: string[]
 * }>}
 */
export async function release(options = {}) {
  const {
    cwd = process.cwd(),
    logger = console,
    distTag,
    excludePrivate = false,
    forceRelease = false,
    build = true
  } = options;

  const prompter = options.prompter ?? createInteractivePrompter();

  // ── process runner, scoped to the target repository ─────────────────────────

  const run = options.run ?? createRun(cwd);

  // Highest published version, including pre-releases, used as the change
  // detection baseline. `latest` alone is not enough — an in-progress
  // pre-release (published under e.g. `next`) is newer than `latest`.
  const getNpmVersion = async (name) => {
    try {
      const out = await run('npm', [ 'view', name, 'versions', '--json' ]);
      if (!out) return null;
      const parsed = JSON.parse(out);
      const versions = Array.isArray(parsed) ? parsed : [ parsed ];
      return versions.length ? maxVersion(versions) : null;
    } catch {
      return null;
    }
  };

  const tagExists = async (tag) => {
    try {
      await run('git', [ 'rev-parse', tag, '--' ]);
      return true;
    } catch {
      return false;
    }
  };

  const findPublishTag = async (name, version) => {
    const tag = `${name}@${version}`;
    return await tagExists(tag) ? tag : null;
  };

  const hasChangesSince = async (tag, dir) => {
    const changes = await run('git', [ 'log', `${tag}..HEAD`, '--', dir ]);

    return changes.length > 0;
  };

  const commitsSince = async (tag, dir) => {
    if (!tag) return [];
    const out = await run('git', [ 'log', `${tag}..HEAD`, '--pretty=format:%s', '--', dir ]);
    return out ? out.split('\n') : [];
  };

  const printCommits = (commits) => {
    if (commits.length) {
      for (const subject of commits) logger.log(`    • ${subject}`);
    } else {
      logger.log('    • (no changes)');
    }
  };

  try {
    const rootPkg = readJSON(join(cwd, 'package.json'));
    const strategy = resolveStrategy(rootPkg);
    const commitMessage = resolveCommitMessage(rootPkg, strategy);
    const packages = topoSort(discoverPackages(cwd, rootPkg, { logger, excludePrivate }));

    // ── phase 0: pre-flight ──────────────────────────────────────────────────

    const uncommittedFiles = await run('git', [ 'status', '--porcelain' ]);
    if (uncommittedFiles.length > 0) {
      throw new ReleaseError('Working tree has uncommitted changes. Commit or stash them before releasing.');
    }

    // npm auth is only needed when at least one package will actually be
    // published. An all-private release (version + tag only) needs no npm login.
    if (packages.some(({ pkg }) => !pkg.private)) {
      try {
        await run('npm', [ 'whoami' ]);
      } catch {
        throw new ReleaseError('Not authenticated with npm. Run `npm login` before releasing.');
      }
    }

    // Install once, up front, so build/test/publish later run against consistent
    // node_modules — versioning itself only refreshes the lockfile
    // (`npm install --package-lock-only`) and never touches node_modules. Because
    // the tree was just asserted clean, any change `npm install` makes is a stale
    // committed lockfile: fail rather than fold that drift into the release commit.
    await run('npm', [ 'install' ], { stdio: 'inherit' });

    const staleLockfile = await run('git', [ 'status', '--porcelain' ]);
    if (staleLockfile.length > 0) {
      throw new ReleaseError('Lockfile is out of date. Run `npm install` and commit the changes before releasing.');
    }

    // ── phase 1: detect ──────────────────────────────────────────────────────

    logger.log(`Release strategy: ${strategy}\n`);
    logger.log('Detecting changes...\n');

    const infos = await Promise.all(packages.map(
      async ({ dir, name, pkg }) => {
        const isPrivate = !!pkg.private;

        // Private packages are never published, so their baseline comes from
        // package.json rather than the npm registry.
        const npmVersion = isPrivate ? null : await getNpmVersion(name);
        const currentVersion = (isPrivate ? pkg.version : npmVersion) || '0.0.0';

        return { dir, name, pkg, private: isPrivate, npmVersion, currentVersion };
      }
    ));

    // ── phase 2: plan ────────────────────────────────────────────────────────

    const { plan, candidates } = strategy === 'fixed'
      ? await planFixed(infos)
      : await planIndependent(infos);

    if (plan.length === 0) {
      logger.log('\nNothing to publish.');
      return { strategy, released: [], skipped: candidates.map(c => c.name) };
    }

    // Resolve (and validate) the dist-tag every planned version publishes under
    // before anything destructive happens, so an unsafe pre-release fails fast.
    // A dist-tag chosen interactively (per decision) wins over the global one.
    for (const p of plan) {

      // Private packages are never published, so dist-tag rules don't apply.
      if (p.private) {
        continue;
      }

      p.distTag = resolveDistTag(p.newVersion, p.distTag ?? distTag);
    }

    logger.log('\nRelease plan:');
    for (const { name, currentVersion, newVersion, bump, distTag: tag, private: isPrivate } of plan) {
      const note = isPrivate
        ? ' [private, no publish]'
        : tag === LATEST_DIST_TAG ? '' : ` [dist-tag: ${tag}]`;
      logger.log(`  ${name}: ${currentVersion} → ${newVersion} (${bump})${note}`);
    }

    const skipped = candidates.filter(c => !plan.find(p => p.name === c.name));
    if (skipped.length) {
      logger.log(`  skipped: ${skipped.map(s => s.name).join(', ')}`);
    }

    if (!await prompter.confirm({ plan, strategy })) {
      logger.log('Aborted.');
      return { strategy, released: [], skipped: skipped.map(s => s.name), aborted: true };
    }

    // ── phase 3: execute ─────────────────────────────────────────────────────

    const tags = await executeRelease(strategy, commitMessage, plan, packages);

    logger.log('\nDone.');

    return {
      strategy,
      released: plan.map(p => ({ name: p.name, version: p.newVersion })),
      skipped: skipped.map(s => s.name),
      tags
    };
  } finally {
    prompter.close?.();
  }

  // ── planners ────────────────────────────────────────────────────────────────

  // Independent: each package is detected and tagged as `${name}@${version}`
  // and bumped on its own; dependents cascade in.
  async function planIndependent(infos) {
    const changed = [];
    const changingNames = new Set(); // confirmed for release so far (topological order)

    for (const info of infos) {

      // Private packages have no npm baseline; fall back to their current
      // (package.json) version, matched against the `name@version` git tag.
      const baselineVersion = info.private ? info.currentVersion : info.npmVersion;
      const tag = baselineVersion ? await findPublishTag(info.name, baselineVersion) : null;

      // Baselined but untagged — we can't detect its changes, so leave it out.
      // Forced releases skip change detection, so a missing tag is fine.
      if (!forceRelease && baselineVersion && !tag) {
        logger.warn(`  warning: ${info.name}@${baselineVersion} — no git tag found`);
        logger.warn(`  Create tag '${info.name}@${baselineVersion}' to enable change detection.\n`);
        continue;
      }

      let reason = forceRelease
        ? 'forced (--force-release)'
        : !baselineVersion
          ? 'not yet published'
          : await hasChangesSince(tag, info.dir) ? `changes since ${tag}`
            : isPrerelease(baselineVersion) ? `pre-release ${baselineVersion} in progress`
              : null;

      // Cascade: release a package when a workspace dependency is being released.
      // Safe because `infos` is topologically sorted — deps are evaluated first.
      if (!reason) {
        const allDeps = { ...info.pkg.dependencies, ...info.pkg.devDependencies, ...info.pkg.peerDependencies };
        const changedDep = [ ...changingNames ].find(n => n in allDeps);
        if (changedDep) reason = `dep ${changedDep} changing`;
      }

      if (reason) {
        changed.push({ ...info, tag, reason });
        changingNames.add(info.name);
      }
    }

    if (changed.length === 0) {
      return { plan: [], candidates: [] };
    }

    logger.log('Changed packages:');
    for (const { name, reason } of changed) logger.log(`  ${name} — ${reason}`);
    logger.log('\nHow should each package be bumped?');

    const plan = [];
    for (const info of changed) {
      const unreleasedCommits = await commitsSince(info.tag, info.dir);

      logger.log(`\n  ${info.name} — ${info.reason}`);
      printCommits(unreleasedCommits);
      logger.log('');

      const decision = await prompter.bump({ name: info.name, currentVersion: info.currentVersion });
      if (decision === 'skip') continue;

      const { type, preid, distTag } = decision;
      plan.push({ ...info, bump: type, preid, distTag, newVersion: resolveVersion(type, info.currentVersion, preid) });
    }

    return { plan, candidates: changed };
  }

  // Fixed: all released packages share one version, detected against the
  // `v${version}` release tag and published together under a single new
  // `v${version}` tag. Only packages that changed since the baseline (plus the
  // workspace dependents they drag along) are released — unchanged packages keep
  // their current version and are left behind until something touches them, at
  // which point they rejoin at the then-current shared version (lerna-style).
  async function planFixed(infos) {
    const sharedVersion = maxVersion(infos.map(i => i.currentVersion));
    const baselineTag = await tagExists(`v${sharedVersion}`) ? `v${sharedVersion}` : null;

    if (!baselineTag) {
      logger.warn(`  warning: no 'v${sharedVersion}' tag found — treating all packages as changed.\n`);
    }

    // Per-package changes since the shared baseline, grouped by package name.
    const groups = await Promise.all(infos.map(
      async info => ({ info, commits: await commitsSince(baselineTag, info.dir) })
    ));

    // Select the release set: packages with their own changes, plus dependents
    // that cascade in. `infos` is topologically sorted, so a dependency is always
    // decided before the packages that depend on it.
    const releasingNames = new Set();
    const selected = [];

    for (const { info, commits } of groups) {

      // Private packages have no npm baseline; fall back to their current
      // (package.json) version for change / pre-release detection.
      const baselineVersion = info.private ? info.currentVersion : info.npmVersion;

      let reason =
        forceRelease ? 'forced (--force-release)' :
          !baselineTag ? 'no release tag' :
            !baselineVersion ? 'not yet published' :
              commits.length > 0 ? `changes since ${baselineTag}` :
                isPrerelease(baselineVersion) ? `pre-release ${baselineVersion} in progress` :
                  null;

      // Cascade: a package pinning a released workspace dependency must be
      // republished so its dependency range points at the new version.
      if (!reason) {
        const allDeps = { ...info.pkg.dependencies, ...info.pkg.devDependencies, ...info.pkg.peerDependencies };
        const changedDep = [ ...releasingNames ].find(n => n in allDeps);
        if (changedDep) reason = `dep ${changedDep} changing`;
      }

      if (reason) {
        selected.push({ info, commits, reason });
        releasingNames.add(info.name);
      }
    }

    if (selected.length === 0) {
      return { plan: [], candidates: [] };
    }

    logger.log(`Shared version: ${sharedVersion}`);
    logger.log(`\nReleasing since ${baselineTag ?? '(no release tag)'}:`);
    for (const { info, commits, reason } of selected) {
      logger.log(`\n  ${info.name} — ${reason}`);
      printCommits(commits);
    }

    const unchanged = infos.filter(i => !releasingNames.has(i.name));
    if (unchanged.length) {
      logger.log(`\n  unchanged (left at current version): ${unchanged.map(i => i.name).join(', ')}`);
    }
    logger.log('\nAll released packages move together to one shared version.\n');

    const decision = await prompter.bump({ name: 'all packages', currentVersion: sharedVersion });
    if (decision === 'skip') {
      return { plan: [], candidates: [] };
    }

    const { type, preid, distTag } = decision;
    const newVersion = resolveVersion(type, sharedVersion, preid);
    const plan = selected.map(({ info }) => ({ ...info, bump: type, preid, distTag, newVersion }));

    // `candidates` spans every package so the caller can report the unchanged
    // ones as skipped alongside the released set.
    return { plan, candidates: infos };
  }

  // ── executor ────────────────────────────────────────────────────────────────

  async function executeRelease(strategy, commitMessage, plan, packages) {

    // Apply all version bumps + dependency pins in a single update, so every
    // library moves to its release version together (lerna-style), rather than
    // one commit per package. This is the same stamping primitive `setVersion`
    // uses — here the versions are *decided* per changed package rather than a
    // single explicit version, and we go on to commit, tag and publish.
    const { changed, pins } = await applyVersions({
      cwd,
      run,
      updates: plan.map(({ dir, name, newVersion }) => ({ dir, name, version: newVersion })),
      repinScope: packages
    });

    // The version each package ends up at: its release version if it is part of
    // this run, otherwise its current (unreleased) version.
    const resultingVersion = new Map(packages.map(({ name, pkg }) => [ name, pkg.version ]));
    for (const { name, newVersion } of plan) resultingVersion.set(name, newVersion);

    // A stable package pinning a pre-release dependency ships an alpha to
    // everyone on `latest`. Not necessarily wrong, but rarely intended.
    for (const { dependent, dependency, version } of pins) {
      const dependentVersion = resultingVersion.get(dependent);
      if (isPrerelease(version) && dependentVersion && !isPrerelease(dependentVersion)) {
        logger.warn(`  warning: ${dependent}@${dependentVersion} (stable) pins pre-release ${dependency}@${version}`);
      }
    }

    const stagedPaths = new Set([ 'package-lock.json', ...changed ]);

    // Commit the whole release as a single update.
    for (const p of stagedPaths) await run('git', [ 'add', p ]);
    await run('git', [ 'commit', '-m', commitMessage.replaceAll(VERSION_PLACEHOLDER, `v${plan[0].newVersion}`) ]);

    // Build, test, publish, and tag against that single commit.
    //   - independent: one `${name}@${version}` tag per published package.
    //   - fixed:       one shared `v${version}` tag for the whole release.
    const tags = [];

    for (const { dir, name, newVersion, distTag: tag, private: isPrivate, pkg } of plan) {
      logger.log(`\n${name}@${newVersion}`);

      // Build and test against the committed state. Skipped entirely when
      // building is disabled, and skipped (with a warning) for a package that
      // has no `all` script — a repo whose artifacts are built elsewhere (e.g.
      // in CI, off the release tag) does not build per package here.
      if (!build) {
        logger.log('  build disabled — skipping');
      } else if (pkg.scripts?.[BUILD_SCRIPT]) {
        await run('npm', [ 'run', BUILD_SCRIPT ], { cwd: join(cwd, dir), stdio: 'inherit' });
      } else {
        logger.warn(`  no '${BUILD_SCRIPT}' script — skipping build`);
      }

      // Publish. Access (public/restricted) is taken from each package's
      // own package.json#publishConfig. A non-`latest` dist-tag (always the
      // case for pre-releases) is passed explicitly so they never land on
      // `latest`. Private packages are versioned + tagged but never published.
      if (isPrivate) {
        logger.log('  private — skipping npm publish');
      } else {
        const publishArgs = [ 'publish' ];
        if (tag !== LATEST_DIST_TAG) publishArgs.push('--tag', tag);
        await run('npm', publishArgs, { cwd: join(cwd, dir), stdio: 'inherit' });
      }

      if (strategy === 'independent') {
        const gitTag = `${name}@${newVersion}`;
        await run('git', [ 'tag', gitTag ]);
        tags.push(gitTag);
        logger.log(`  tagged ${gitTag}`);
      }
    }

    if (strategy === 'fixed') {
      const tag = `v${plan[0].newVersion}`;
      await run('git', [ 'tag', tag ]);
      tags.push(tag);
      logger.log(`\ntagged ${tag}`);
    }

    // Push the release commit and all tags together.
    await run('git', [ 'push', REMOTE, 'HEAD' ]);
    for (const tag of tags) await run('git', [ 'push', REMOTE, tag ]);

    return tags;
  }
}
