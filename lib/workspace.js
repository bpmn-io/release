import { readFileSync, globSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Read and parse a JSON file.
 *
 * @param {string} path
 * @return {any}
 */
export function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Discover workspace packages from a root `package.json` `workspaces` field,
 * expanding any globs (e.g. `packages/*`, `apps/*`) to actual package dirs.
 *
 * Returns `{ dir, name, pkg }` entries where `dir` is the workspace-relative
 * path — never assume the directory name matches the package name. Private
 * packages are skipped, since they are never published.
 *
 * @param {string} cwd repository root
 * @param {any} rootPkg parsed root package.json
 * @param {{ warn: Function }} [logger]
 * @return {Array<{ dir: string, name: string, pkg: any }>}
 */
export function discoverPackages(cwd, rootPkg, logger = console) {
  const patterns = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : rootPkg.workspaces?.packages ?? [];

  const seen = new Set();
  const packages = [];

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      logger.warn(`  warning: ignoring unsupported negated workspace pattern '${pattern}'`);
      continue;
    }
    for (const rel of globSync(`${pattern}/package.json`, { cwd }).sort()) {
      const dir = dirname(rel);
      if (seen.has(dir)) continue;
      seen.add(dir);

      const pkg = readJSON(join(cwd, rel));

      // Private packages are never published — skip them entirely.
      if (pkg.private) continue;

      packages.push({ dir, name: pkg.name, pkg });
    }
  }

  return packages;
}

/**
 * Order packages so every dependency comes before its dependents, considering
 * only edges between workspace packages (deps, devDeps, peerDeps). Throws on a
 * dependency cycle.
 *
 * @param {Array<{ name: string, pkg: any }>} packages
 * @return {Array} packages, dependencies before dependents
 */
export function topoSort(packages) {
  const byName = new Map(packages.map(p => [ p.name, p ]));
  const state = new Map(); // name -> 'visiting' | 'done'
  const ordered = [];

  function visit(pkg, stack) {
    if (state.get(pkg.name) === 'done') return;
    if (state.get(pkg.name) === 'visiting') {
      throw new Error(`dependency cycle detected: ${[ ...stack, pkg.name ].join(' -> ')}`);
    }
    state.set(pkg.name, 'visiting');

    const deps = { ...pkg.pkg.dependencies, ...pkg.pkg.devDependencies, ...pkg.pkg.peerDependencies };
    for (const depName of Object.keys(deps)) {
      const dep = byName.get(depName);
      if (dep) visit(dep, [ ...stack, pkg.name ]);
    }

    state.set(pkg.name, 'done');
    ordered.push(pkg);
  }

  for (const pkg of packages) visit(pkg, []);
  return ordered;
}

const DEFAULT_PREID = 'alpha';

// Bump levels the tool understands. The `pre*` levels start or move a
// pre-release; the plain levels also finalize ("graduate") a pre-release.
export const BUMP_TYPES = [
  'major', 'minor', 'patch',
  'premajor', 'preminor', 'prepatch', 'prerelease'
];

/**
 * Parse a `major.minor.patch[-prerelease]` version into its components.
 *
 * The `prerelease` field is the dot-separated identifier list (e.g.
 * `['alpha', 0]`, numeric identifiers coerced to numbers) or an empty array for
 * a stable version. Build metadata (`+…`) is ignored.
 *
 * @param {string} version
 * @return {{ major: number, minor: number, patch: number, prerelease: Array<string|number> }}
 */
export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/.exec(version);
  if (!match) {
    throw new Error(`invalid version: ${version}`);
  }

  const [ , major, minor, patch, pre ] = match;

  const prerelease = pre
    ? pre.split('.').map(id => (/^\d+$/.test(id) ? Number(id) : id))
    : [];

  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
}

/**
 * Whether a version carries a pre-release identifier (e.g. `1.3.0-alpha.0`).
 *
 * @param {string} version
 * @return {boolean}
 */
export function isPrerelease(version) {
  return parseVersion(version).prerelease.length > 0;
}

function formatVersion({ major, minor, patch, prerelease }) {
  const base = `${major}.${minor}.${patch}`;
  return prerelease.length ? `${base}-${prerelease.join('.')}` : base;
}

// Move a version's pre-release identifier forward: keep counting when the
// identifier matches (`alpha.0` -> `alpha.1`), otherwise (re)start at `<preid>.0`.
function incPrerelease(prerelease, preid) {
  if (prerelease.length && prerelease[0] === preid && typeof prerelease[prerelease.length - 1] === 'number') {
    const next = [ ...prerelease ];
    next[next.length - 1] = next[next.length - 1] + 1;
    return next;
  }
  return [ preid, 0 ];
}

/**
 * Apply a semver bump to a version, mirroring `semver.inc` semantics.
 *
 * Plain `major`/`minor`/`patch` finalize ("graduate") a pre-release when one is
 * present (e.g. `1.3.0-alpha.2` --patch--> `1.3.0`), otherwise increment as
 * usual. The `pre*` levels start or advance a pre-release using `preid`.
 *
 * @param {string} version
 * @param {'major'|'minor'|'patch'|'premajor'|'preminor'|'prepatch'|'prerelease'} bump
 * @param {string} [preid] pre-release identifier for `pre*` bumps (default: alpha)
 * @return {string}
 */
export function bumpVersion(version, bump, preid = DEFAULT_PREID) {
  const { major, minor, patch, prerelease } = parseVersion(version);
  const pre = prerelease.length > 0;

  switch (bump) {
  case 'major':
    return formatVersion({ major: pre && minor === 0 && patch === 0 ? major : major + 1, minor: 0, patch: 0, prerelease: [] });
  case 'minor':
    return formatVersion({ major, minor: pre && patch === 0 ? minor : minor + 1, patch: 0, prerelease: [] });
  case 'patch':
    return formatVersion({ major, minor, patch: pre ? patch : patch + 1, prerelease: [] });
  case 'premajor':
    return formatVersion({ major: major + 1, minor: 0, patch: 0, prerelease: [ preid, 0 ] });
  case 'preminor':
    return formatVersion({ major, minor: minor + 1, patch: 0, prerelease: [ preid, 0 ] });
  case 'prepatch':
    return formatVersion({ major, minor, patch: patch + 1, prerelease: [ preid, 0 ] });
  case 'prerelease':
    return pre
      ? formatVersion({ major, minor, patch, prerelease: incPrerelease(prerelease, preid) })
      : formatVersion({ major, minor, patch: patch + 1, prerelease: [ preid, 0 ] });
  default:
    throw new Error(`unknown bump type: ${bump}`);
  }
}

// Compare two pre-release identifier lists per semver precedence rules.
// An empty list (stable) outranks any pre-release.
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // stable > pre-release
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1; // shorter set of identifiers = lower precedence
    if (i >= b.length) return 1;

    const x = a[i], y = b[i];
    if (x === y) continue;

    const xNum = typeof x === 'number', yNum = typeof y === 'number';
    if (xNum && yNum) return x - y;
    if (xNum) return -1; // numeric < alphanumeric
    if (yNum) return 1;
    return x < y ? -1 : 1; // alphanumeric compared lexically
  }
  return 0;
}

/**
 * Compare two versions per semver precedence, including pre-release ordering
 * (`1.3.0-alpha.0` < `1.3.0-alpha.1` < `1.3.0`).
 *
 * @param {string} a
 * @param {string} b
 * @return {number} negative if a < b, positive if a > b, 0 if equal
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);

  for (const key of [ 'major', 'minor', 'patch' ]) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }

  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * Highest of a list of `major.minor.patch` versions.
 *
 * @param {string[]} versions
 * @return {string}
 */
export function maxVersion(versions) {
  return versions.reduce((a, b) => compareVersions(a, b) >= 0 ? a : b, '0.0.0');
}
