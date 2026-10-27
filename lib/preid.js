import { ReleaseError } from './error.js';

import { BUMP_TYPES, parseVersion } from './workspace.js';

// Bump levels that remain valid with --preid.
export const PRE_BUMP_TYPES = [ 'premajor', 'preminor', 'prepatch', 'prerelease' ];

/**
 * Assert that a `--preid` value is a valid pre-release identifier.
 *
 * @param {string} preid
 */
export function assertPreid(preid) {
  if (preid === undefined) {
    throw new ReleaseError('--preid requires a value (e.g. alpha, beta, rc, next).');
  }

  // numeric identifiers must not have leading zeroes (`01`), per semver
  if (typeof preid !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z-]*$/.test(preid) || /^0\d+$/.test(preid)) {
    throw new ReleaseError(
      `Invalid --preid ${JSON.stringify(preid)}; expected a pre-release identifier ` +
      '(letters, digits and hyphens, e.g. alpha, beta, rc, next).'
    );
  }
}

/**
 * Explain why a spec contradicts a governed pre-release identifier.
 *
 * With a `preid`, a spec must be `skip`, a `pre*` level or an explicit
 * pre-release version carrying that identifier. Unrecognised specs are left
 * to the caller to validate.
 *
 * @param {string} spec bump level, `skip` or explicit version
 * @param {string} [preid] governed identifier; no-op when not given
 * @return {string|undefined} the reason, or `undefined` if acceptable
 */
export function preidConflict(spec, preid) {
  if (preid === undefined || spec === 'skip' || PRE_BUMP_TYPES.includes(spec)) {
    return undefined;
  }

  const hint =
    `With --preid only ${PRE_BUMP_TYPES.join(', ')}, skip or an explicit ` +
    `${preid} pre-release version (e.g. 1.3.0-${preid}.0) are allowed. ` +
    'Run without --preid to release a stable version.';

  if (BUMP_TYPES.includes(spec)) {
    return `"${spec}" would release a stable version, but --preid ${preid} was given. ${hint}`;
  }

  let version;
  try {
    version = parseVersion(spec);
  } catch {
    return undefined;
  }

  if (!version.prerelease.length) {
    return `${spec} is a stable version, but --preid ${preid} was given. ${hint}`;
  }

  if (String(version.prerelease[0]) !== preid) {
    return `${spec} does not use the --preid ${preid} identifier. ${hint}`;
  }

  return undefined;
}

/**
 * Throw a `ReleaseError` if any spec contradicts `preid` (see `preidConflict`).
 * `undefined` specs are ignored.
 *
 * @param {Iterable<string|undefined>} specs
 * @param {string} [preid]
 */
export function assertPreidSpecs(specs, preid) {
  for (const spec of specs) {
    const conflict = spec === undefined ? undefined : preidConflict(spec, preid);

    if (conflict) {
      throw new ReleaseError(conflict);
    }
  }
}
