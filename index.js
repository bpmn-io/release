export { release, ReleaseError, resolveDistTag, LATEST_DIST_TAG } from './lib/release.js';
export { setVersion, resolveVersion } from './lib/version.js';
export { createInteractivePrompter, createScriptedPrompter } from './lib/prompt.js';
export {
  discoverPackages,
  topoSort,
  bumpVersion,
  compareVersions,
  maxVersion,
  parseVersion,
  isPrerelease,
  BUMP_TYPES
} from './lib/workspace.js';
