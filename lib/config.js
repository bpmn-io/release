import { ReleaseError } from './error.js';

const DEFAULT_COMMIT_MESSAGE = 'chore(packages): release';
const DEFAULT_COMMIT_MESSAGE_FIXED = 'chore(packages): release %version';

// Placeholder substituted with the release version (`v`-prefixed, e.g. `v1.2.3`,
// matching the `fixed` release tag) in the commit message.
export const VERSION_PLACEHOLDER = '%version';

/**
 * Resolve and validate the (required) release strategy.
 *
 * The strategy is a property of the repository and is read from
 * `package.json#releaseConfig.strategy`. It is the single source of truth — the
 * caller cannot override or assert it.
 *
 * @param {any} rootPkg
 * @return {'fixed'|'independent'}
 */
export function resolveStrategy(rootPkg) {
  const strategy = rootPkg.releaseConfig?.strategy;

  if (strategy === undefined || strategy === null) {
    throw new ReleaseError('Missing required `releaseConfig.strategy` in package.json (set it to "fixed" or "independent").');
  }
  if (strategy !== 'fixed' && strategy !== 'independent') {
    throw new ReleaseError(`Invalid release strategy ${JSON.stringify(strategy)}; expected "fixed" or "independent".`);
  }

  return strategy;
}

/**
 * Resolve and validate the commit message template used for the single release
 * commit.
 *
 * Read from `package.json#releaseConfig.commitMessage`; falls back to a default
 * when omitted (which includes the `%version` placeholder under the `fixed`
 * strategy). The template may contain a `%version` placeholder which is
 * substituted with the `v`-prefixed release version (e.g. `v1.2.3`, matching the
 * release tag) at commit time. That placeholder only has a single, well-defined
 * value under the `fixed` strategy (where all packages share one version), so it
 * is rejected for any other strategy.
 *
 * @param {any} rootPkg
 * @param {'fixed'|'independent'} strategy
 * @return {string}
 */
export function resolveCommitMessage(rootPkg, strategy) {
  const commitMessage = rootPkg.releaseConfig?.commitMessage;

  if (commitMessage === undefined || commitMessage === null) {
    return strategy === 'fixed' ? DEFAULT_COMMIT_MESSAGE_FIXED : DEFAULT_COMMIT_MESSAGE;
  }

  if (typeof commitMessage !== 'string' || commitMessage.trim().length === 0) {
    throw new ReleaseError('Invalid `releaseConfig.commitMessage`; expected a non-empty string.');
  }

  if (strategy !== 'fixed' && commitMessage.includes(VERSION_PLACEHOLDER)) {
    throw new ReleaseError(`\`releaseConfig.commitMessage\` may not use \`${VERSION_PLACEHOLDER}\` unless the release strategy is "fixed"; the ${strategy} strategy has no single shared release version.`);
  }

  return commitMessage;
}
