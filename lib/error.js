/**
 * Error representing an expected, user-facing failure (bad config, dirty tree,
 * missing auth, …). The CLI prints its message and exits non-zero; anything
 * else bubbles up as an unexpected error.
 */
export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}
