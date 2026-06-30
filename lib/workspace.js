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

/**
 * Apply a semver bump to a `major.minor.patch` version.
 *
 * @param {string} version
 * @param {'major'|'minor'|'patch'} bump
 * @return {string}
 */
export function bumpVersion(version, bump) {
  const [ major, minor, patch ] = version.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump type: ${bump}`);
}

/**
 * Compare two `major.minor.patch` versions.
 *
 * @param {string} a
 * @param {string} b
 * @return {number} negative if a < b, positive if a > b, 0 if equal
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
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
