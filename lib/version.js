import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  readJSON,
  discoverPackages,
  parseVersion,
  formatVersion,
  bumpVersion,
  BUMP_TYPES
} from './workspace.js';

import { createRun } from './exec.js';

import { ReleaseError } from './error.js';

export { ReleaseError } from './error.js';

/**
 * Resolve a version *spec* against a package's current version into a concrete
 * target version.
 *
 * A spec is either an **explicit** semver version (e.g. `1.2.3`,
 * `1.2.0-nightly.0` — used verbatim, normalized) or a **relative** bump level
 * (`patch` | `minor` | `major` | `premajor` | `preminor` | `prepatch` |
 * `prerelease` — incremented off `currentVersion`). This is the single point
 * where "what should this package become?" is decided, shared by `setVersion`
 * (explicit specs) and `release()` (levels or explicit), so both entry points
 * accept the same grammar symmetrically.
 *
 * @param {string} spec explicit version or bump level
 * @param {string} currentVersion the package's current version (used for levels)
 * @param {string} [preid] pre-release identifier for `pre*` levels
 * @return {string} the concrete target version
 */
export function resolveVersion(spec, currentVersion, preid) {
  if (BUMP_TYPES.includes(spec)) {
    return bumpVersion(currentVersion, spec, preid);
  }

  try {
    return formatVersion(parseVersion(spec));
  } catch {
    throw new ReleaseError(
      `Invalid version spec "${spec}"; expected an explicit semver version ` +
      `(e.g. 1.2.3 or 1.2.0-nightly.0) or a bump level (${BUMP_TYPES.join(', ')}).`
    );
  }
}

/**
 * Stamp versions onto workspace packages and reconcile the lockfile — nothing
 * else.
 *
 * This is the pure *version* primitive, deliberately distinct from `release()`.
 * Where `release()` decides versions, commits, tags and (optionally) builds and
 * publishes, `setVersion()` only writes already-decided versions onto disk:
 *
 * - it resolves a target version per package (via `resolveVersion`) — a `default`
 *   spec applies to every discovered package, `overrides[name]` targets specific
 *   ones — and stamps it via `npm version <version> --no-git-tag-version`;
 * - it pins internal workspace dependency ranges to `^<version>`; and
 * - it runs a single `npm install --package-lock-only` to refresh the lockfile.
 *
 * A spec is an explicit version (`1.2.3`, `1.2.0-nightly.0`) or a bump level
 * (`patch`, `minor`, … — resolved off the package's current version). Packages
 * with no applicable spec are left untouched. Private packages are stamped like
 * any other unless `excludePrivate` is set.
 *
 * It never touches git (no add/commit/tag/push), never prompts, never builds and
 * never publishes. That makes it the right tool for a CI/nightly pipeline that
 * needs to stamp a computed version (e.g. `1.2.0-nightly.20250811`) onto its
 * workspaces before building artifacts, without any of the release ceremony.
 *
 * @param {string} [defaultSpec] version spec applied to every discovered package
 *   (explicit version or bump level). Omit to target only `overrides`.
 * @param {object} [options]
 * @param {string} [options.cwd] repository root (default: current directory)
 * @param {{ log: Function, warn: Function }} [options.logger] logger sink
 *   (default: `console`)
 * @param {boolean} [options.excludePrivate] leave private packages untouched
 *   instead of stamping them (default: false)
 * @param {Record<string, string>} [options.overrides] per-package specs
 *   (`{ name: spec }`) taking precedence over `defaultSpec`
 * @param {string} [options.preid] pre-release identifier for `pre*` bump levels
 *   (default: alpha)
 * @param {(file: string, args?: string[], opts?: object) => Promise<string>} [options.run]
 *   process runner used for every npm invocation, resolving with the command's
 *   trimmed stdout (default: a `nano-spawn` runner scoped to `cwd`). Every
 *   external call funnels through this single seam, so injecting a fake runner
 *   drives `setVersion()` end-to-end without touching npm.
 *
 * @return {Promise<Array<{ name: string, version: string }>>} the stamped
 *   packages
 */
export async function setVersion(defaultSpec, options = {}) {
  const {
    cwd = process.cwd(),
    logger = console,
    excludePrivate = false,
    overrides = {},
    preid
  } = options;

  if (defaultSpec === undefined && Object.keys(overrides).length === 0) {
    throw new ReleaseError('No version specified; pass a version, a bump level or per-package overrides.');
  }

  const run = options.run ?? createRun(cwd);

  const rootPkg = readJSON(join(cwd, 'package.json'));
  const packages = discoverPackages(cwd, rootPkg, { logger, excludePrivate });

  if (!packages.length) {
    logger.warn('No packages found — nothing to version.');
    return [];
  }

  // An override naming a package we do not control is almost certainly a typo —
  // surface it rather than silently doing nothing.
  const known = new Set(packages.map(p => p.name));
  for (const name of Object.keys(overrides)) {
    if (!known.has(name)) {
      throw new ReleaseError(`Unknown package "${name}" in overrides; not a workspace package${excludePrivate ? ' (or excluded as private)' : ''}.`);
    }
  }

  // Resolve every target up front (validating specs) so nothing is mutated on
  // invalid input. Packages with no applicable spec are left untouched.
  const assignments = [];
  for (const { dir, name, pkg } of packages) {
    const spec = name in overrides ? overrides[name] : defaultSpec;
    if (spec === undefined) continue;

    assignments.push({ dir, name, version: resolveVersion(spec, pkg.version, preid) });
  }

  if (!assignments.length) {
    logger.warn('No packages matched — nothing to version.');
    return [];
  }

  await applyVersions({
    cwd,
    run,
    updates: assignments,
    repinScope: packages
  });

  const stamped = assignments.map(({ name, version }) => ({ name, version }));

  logger.log(`Set version on ${stamped.length} package(s):`);
  for (const { name, version } of stamped) logger.log(`  ${name}@${version}`);

  return stamped;
}

/**
 * Apply a set of version updates to the workspace: stamp each named package to
 * its target version via `npm version <v> --no-git-tag-version`, re-pin internal
 * workspace dependency ranges to `^<version>`, then run a single
 * `npm install --package-lock-only` to refresh the lockfile.
 *
 * The lockfile refresh is deliberately node_modules-free: a version bump only
 * changes internal workspace versions and their `^` ranges, so node_modules
 * needs no rewrite. Callers that build/test/publish afterwards are responsible
 * for ensuring node_modules is installed and consistent beforehand.
 *
 * This is the shared mechanism behind both `setVersion` — whose *decision* is
 * trivial ("use exactly this version everywhere") — and `release()`, which
 * decides per-package release versions for the changed subset. It mirrors how
 * `lerna publish` builds on `lerna version`: what differs between the two is how
 * the versions are *decided* and how far execution runs afterwards; the stamping
 * itself is one primitive. `applyVersions` never touches git, prompts, builds or
 * publishes — callers layer that on top.
 *
 * The `updates` list is the single source of truth: its `dir`s say what to stamp
 * and its `name`→`version` pairs say what internal dependency ranges pin to, so
 * the two can never drift apart.
 *
 * @param {object} args
 * @param {string} args.cwd repository root
 * @param {(file: string, args?: string[], opts?: object) => Promise<string>} args.run
 *   process runner every npm invocation funnels through
 * @param {Array<{ dir: string, name: string, version: string }>} args.updates the
 *   packages to version: each `dir` is stamped to `version`, and every internal
 *   range referencing `name` is pinned to `^version`
 * @param {Array<{ dir: string }>} args.repinScope package dirs to scan and re-pin
 *   internal dependency ranges in (typically every workspace package, since even
 *   an un-versioned package may depend on a versioned one)
 * @return {Promise<{ changed: Set<string>, pins: Array<{ dependent: string, dependency: string, version: string }> }>}
 *   `changed` is the set of workspace-relative package.json paths that were
 *   written; `pins` records every internal range that was re-pinned — the
 *   `dependent` package whose manifest was edited, the `dependency` that was
 *   pinned and the `version` it now points at. Callers correlate `pins` with
 *   their own plan to report on the outcome (e.g. a stable package pinning a
 *   pre-release).
 */
export async function applyVersions({ cwd, run, updates, repinScope }) {
  const changed = new Set();
  const pins = [];

  // Stamp every target package to its version.
  for (const { dir, version } of updates) {
    const pkgPath = join(cwd, dir, 'package.json');

    // Idempotent: `npm version <x> --no-git-tag-version` exits non-zero
    // ("Version not changed") when the package is already at x. Skip the call so
    // a re-run — or an explicit spec that equals the current version — is a clean
    // no-op instead of a partial mutation across the sequential stamp loop.
    const current = readJSON(pkgPath).version;
    if (current && formatVersion(parseVersion(current)) === version) continue;

    await run('npm', [ 'version', version, '--no-git-tag-version' ], { cwd: join(cwd, dir) });
    changed.add(`${dir}/package.json`);
  }

  // The internal packages (name → new version) whose dependency ranges we pin.
  const pinnedVersions = new Map(updates.map(({ name, version }) => [ name, version ]));

  // Pin internal workspace dependency ranges to the new versions.
  for (const { dir } of repinScope) {
    const pkgPath = join(cwd, dir, 'package.json');
    const manifest = readJSON(pkgPath);
    let dirty = false;

    for (const field of [ 'dependencies', 'devDependencies', 'peerDependencies' ]) {
      if (!manifest[field]) continue;
      for (const [ dependency, version ] of pinnedVersions) {
        if (!(dependency in manifest[field])) continue;
        manifest[field][dependency] = `^${version}`;
        dirty = true;
        pins.push({ dependent: manifest.name, dependency, version });
      }
    }

    if (dirty) {
      writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n');
      changed.add(`${dir}/package.json`);
    }
  }

  // Refresh the lockfile to resolve the updated ranges — lockfile only, never
  // node_modules. A version bump touches only internal workspace versions and
  // their `^` ranges; external deps are untouched and internal packages are
  // consumed via symlinks that already reflect the freshly-stamped dirs, so
  // node_modules needs no rewrite. Keeping this side-effect-free (beyond disk
  // manifests + lockfile) is what makes `setVersion` a pure primitive; callers
  // that go on to build/test/publish (e.g. `release`) ensure node_modules is
  // installed and consistent up front.
  await run('npm', [ 'install', '--package-lock-only' ], { cwd, stdio: 'inherit' });

  return { changed, pins };
}
