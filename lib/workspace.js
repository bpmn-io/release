import { readFileSync, globSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PREID_PART = '[a-zA-Z][a-zA-Z0-9]*';
const PREID_PATTERN = new RegExp(`^${PREID_PART}$`);
const SEMVER_PATTERN = new RegExp(`^(\\d+)\\.(\\d+)\\.(\\d+)(?:-(${PREID_PART})\\.(\\d+))?$`);

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

/**
 * Parse a `major.minor.patch[-preid.n]` version string.
 *
 * @param {string} v
 * @return {{ major: number, minor: number, patch: number, pre: string|null, preN: number|null }}
 */
function parseSemver(v) {
  const m = v.match(SEMVER_PATTERN);
  if (!m) throw new Error(`Cannot parse version: ${v}`);
  return {
    major: +m[1], minor: +m[2], patch: +m[3],
    pre: m[4] ?? null,
    preN: m[5] !== undefined ? +m[5] : null
  };
}

function assertValidPreid(preid) {
  if (!PREID_PATTERN.test(preid)) {
    throw new Error(`Invalid prerelease identifier: ${preid}`);
  }
}

/**
 * Apply a semver bump to a version string.
 *
 * Stable bumps: `major`, `minor`, `patch`.
 * Prerelease bumps: `premajor`, `preminor`, `prepatch` start a new prerelease at
 * `<bumped-base>-<preid>.0`; `prerelease` increments an existing prerelease counter
 * (or starts a new prepatch prerelease when called on a stable version).
 *
 * @param {string} version
 * @param {'major'|'minor'|'patch'|'premajor'|'preminor'|'prepatch'|'prerelease'} bump
 * @param {string} [preid] prerelease identifier, e.g. `'alpha'` (default)
 * @return {string}
 */
export function bumpVersion(version, bump, preid = 'alpha') {
  const { major, minor, patch, pre: curPre, preN: curPreN } = parseSemver(version);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  assertValidPreid(preid);
  if (bump === 'premajor') return `${major + 1}.0.0-${preid}.0`;
  if (bump === 'preminor') return `${major}.${minor + 1}.0-${preid}.0`;
  if (bump === 'prepatch') return `${major}.${minor}.${patch + 1}-${preid}.0`;
  if (bump === 'prerelease') {
    if (curPre === preid) return `${major}.${minor}.${patch}-${preid}.${curPreN + 1}`;
    // Different channel or stable version → start a new prepatch prerelease.
    return curPre
      ? `${major}.${minor}.${patch}-${preid}.0`
      : `${major}.${minor}.${patch + 1}-${preid}.0`;
  }
  throw new Error(`unknown bump type: ${bump}`);
}

/**
 * Compare two semver strings (stable or prerelease).
 * Prerelease sorts below release at the same base: `1.0.0-alpha.1 < 1.0.0`.
 *
 * @param {string} a
 * @param {string} b
 * @return {number} negative if a < b, positive if a > b, 0 if equal
 */
export function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (const k of [ 'major', 'minor', 'patch' ]) {
    if (pa[k] !== pb[k]) return pa[k] - pb[k];
  }
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (!pa.pre && !pb.pre) return 0;
  if (pa.pre !== pb.pre) return pa.pre < pb.pre ? -1 : 1;
  return pa.preN - pb.preN;
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
