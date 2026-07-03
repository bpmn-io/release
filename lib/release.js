import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  readJSON,
  discoverPackages,
  topoSort,
  bumpVersion,
  maxVersion
} from './workspace.js';

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
    logger = console
  } = options;

  const prompter = options.prompter ?? createInteractivePrompter();

  // ── process runner, scoped to the target repository ─────────────────────────

  const run = createRun(cwd);

  const getNpmVersion = async (name) => {
    try {
      return await run('npm', [ 'view', name, 'version' ]);
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
    const packages = topoSort(discoverPackages(cwd, rootPkg, logger));

    // ── phase 0: pre-flight ──────────────────────────────────────────────────

    const uncommittedFiles = await run('git', [ 'status', '--porcelain' ]);
    if (uncommittedFiles.length > 0) {
      throw new ReleaseError('Working tree has uncommitted changes. Commit or stash them before releasing.');
    }

    try {
      await run('npm', [ 'whoami' ]);
    } catch {
      throw new ReleaseError('Not authenticated with npm. Run `npm login` before releasing.');
    }

    // ── phase 1: detect ──────────────────────────────────────────────────────

    logger.log(`Release strategy: ${strategy}\n`);
    logger.log('Detecting changes...\n');

    const infos = await Promise.all(packages.map(
      async ({ dir, name, pkg }) => {
        const npmVersion = await getNpmVersion(name);
        return { dir, name, pkg, npmVersion, currentVersion: npmVersion || '0.0.0' };
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

    logger.log('\nRelease plan:');
    for (const { name, currentVersion, newVersion, bump } of plan) {
      logger.log(`  ${name}: ${currentVersion} → ${newVersion} (${bump})`);
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

    const tags = await executeRelease(strategy, plan, packages);

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
      const tag = info.npmVersion ? await findPublishTag(info.name, info.npmVersion) : null;

      // Published but untagged — we can't detect its changes, so leave it out.
      if (info.npmVersion && !tag) {
        logger.warn(`  warning: ${info.name}@${info.npmVersion} — no git tag found`);
        logger.warn(`  Create tag '${info.name}@${info.npmVersion}' to enable change detection.\n`);
        continue;
      }

      let reason = !info.npmVersion
        ? 'not yet published'
        : await hasChangesSince(tag, info.dir) ? `changes since ${tag}` : null;

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

      const bump = await prompter.bump({ name: info.name, currentVersion: info.currentVersion });
      if (bump === 'skip') continue;

      plan.push({ ...info, bump, newVersion: bumpVersion(info.currentVersion, bump) });
    }

    return { plan, candidates: changed };
  }

  // Fixed: all packages share one version, detected against the `v${version}`
  // release tag and published together under a single new `v${version}` tag.
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
    const anyChange = !baselineTag || groups.some(g => g.commits.length > 0);

    if (!anyChange) {
      return { plan: [], candidates: [] };
    }

    logger.log(`Shared version: ${sharedVersion}`);
    logger.log(`\nChanges since ${baselineTag ?? '(no release tag)'}:`);
    for (const { info, commits } of groups) {
      logger.log(`\n  ${info.name}`);
      printCommits(commits);
    }
    logger.log('\nAll packages are released together at one shared version.\n');

    const bump = await prompter.bump({ name: 'all packages', currentVersion: sharedVersion });
    if (bump === 'skip') {
      return { plan: [], candidates: [] };
    }

    const newVersion = bumpVersion(sharedVersion, bump);
    const plan = infos.map(info => ({ ...info, bump, newVersion }));

    return { plan, candidates: plan };
  }

  // ── executor ────────────────────────────────────────────────────────────────

  async function executeRelease(strategy, plan, packages) {
    // Map of every library being released to its target version.
    const releasing = new Map(plan.map(p => [ p.name, p.newVersion ]));

    // Apply all version bumps + dependency pins in a single update, so every
    // library moves to its release version together (lerna-style), rather than
    // one commit per package.
    const stagedPaths = new Set([ 'package-lock.json' ]);

    for (const { dir, newVersion } of plan) {
      await run('npm', [ 'version', newVersion, '--no-git-tag-version' ], { cwd: join(cwd, dir) });
      stagedPaths.add(`${dir}/package.json`);
    }

    // Pin the new versions in every workspace package that depends on a released one.
    for (const { dir } of packages) {
      const pkgPath = join(cwd, dir, 'package.json');
      const pkg = readJSON(pkgPath);
      let dirty = false;

      for (const field of [ 'dependencies', 'devDependencies', 'peerDependencies' ]) {
        if (!pkg[field]) continue;
        for (const [ name, newVersion ] of releasing) {
          if (!(name in pkg[field])) continue;
          pkg[field][name] = `^${newVersion}`;
          dirty = true;
        }
      }

      if (dirty) {
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        stagedPaths.add(`${dir}/package.json`);
      }
    }

    // Install once to resolve the updated ranges and refresh the lockfile.
    await run('npm', [ 'install' ], { stdio: 'inherit' });

    // Commit the whole release as a single update.
    for (const p of stagedPaths) await run('git', [ 'add', p ]);
    await run('git', [ 'commit', '-m', commitMessage.replaceAll(VERSION_PLACEHOLDER, `v${plan[0].newVersion}`) ]);

    // Build, test, publish, and tag against that single commit.
    //   - independent: one `${name}@${version}` tag per published package.
    //   - fixed:       one shared `v${version}` tag for the whole release.
    const tags = [];

    for (const { dir, name, newVersion } of plan) {
      logger.log(`\n${name}@${newVersion}`);

      // Build and test against the committed state.
      await run('npm', [ 'run', BUILD_SCRIPT ], { cwd: join(cwd, dir), stdio: 'inherit' });

      // Publish. Access (public/restricted) is taken from each package's
      // own package.json#publishConfig.
      await run('npm', [ 'publish' ], { cwd: join(cwd, dir), stdio: 'inherit' });

      if (strategy === 'independent') {
        const tag = `${name}@${newVersion}`;
        await run('git', [ 'tag', tag ]);
        tags.push(tag);
        logger.log(`  tagged ${tag}`);
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
