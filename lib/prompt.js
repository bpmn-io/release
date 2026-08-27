import { createInterface } from 'node:readline';

import { bumpVersion, parseVersion, isPrerelease } from './workspace.js';

const STABLE_CHOICES = [ 'patch', 'minor', 'major' ];
const PRE_CHOICES = [ 'premajor', 'preminor', 'prepatch', 'prerelease' ];
const BUMP_CHOICES = [ ...STABLE_CHOICES, ...PRE_CHOICES, 'skip' ];

const DEFAULT_PREID = 'alpha';

// A decision is valid when it is a bump level, `skip`, or an explicit semver
// version (e.g. `1.2.3`, `1.2.0-nightly.0`) — the latter used verbatim.
function isExplicitVersion(spec) {
  try {
    parseVersion(spec);
    return true;
  } catch {
    return false;
  }
}

/**
 * A prompter drives the interactive decisions a release needs:
 *
 *   bump({ name, currentVersion, publish }) => { type, preid, distTag } | 'skip'
 *   confirm({ plan, strategy })             => boolean
 *   close()                                 => void
 *
 * `bump()` resolves to `'skip'` to leave a package out, or to a
 * `{ type, preid, distTag }` decision where `type` is one of
 * `patch | minor | major | premajor | preminor | prepatch | prerelease`,
 * `preid` (the pre-release identifier, e.g. `alpha`) applies to the `pre*`
 * types, and `distTag` is the npm dist-tag chosen for a `pre*` bump (never
 * `latest`; `undefined` for a stable bump, which defaults to `latest`). A
 * dist-tag is only asked for when the bump will actually be published
 * (`publish`, default `true`) — an all-private release publishes nothing.
 *
 * Inject a custom prompter into `release()` to run head-less (see
 * `createScriptedPrompter`) or to integrate with a different UI.
 */

/**
 * Interactive prompter backed by readline. The default frontend.
 *
 * A `preid` given here is governed (e.g. via the CLI `--preid`): it is used
 * verbatim for every `pre*` bump and the identifier is never prompted for.
 * Without it, the identifier is asked for, defaulting to `alpha`. Likewise a
 * governed `distTag` (e.g. via `--dist-tag`) is used verbatim and never
 * prompted for; without it the dist-tag is asked for, defaulting to the
 * identifier.
 *
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, preid?: string, distTag?: string }} [io]
 */
export function createInteractivePrompter({ input = process.stdin, output = process.stdout, preid: governedPreid, distTag: governedDistTag } = {}) {
  const rl = createInterface({ input, output });
  const question = q => new Promise(resolve => rl.question(q, a => resolve(a.trim())));

  // A pre-release must never publish to `latest`. A governed `--dist-tag` is
  // used verbatim (it is validated at the release boundary, never `latest`);
  // otherwise keep asking until we get a non-empty, non-`latest` tag, defaulting
  // to the identifier (e.g. `alpha` → tag `alpha`).
  const askDistTag = async (preid) => {
    if (governedDistTag) return governedDistTag;
    const fallback = preid;
    for (;;) {
      const answer = await question(`  npm dist-tag (never 'latest') [${fallback}]: `);
      const tag = answer || fallback;
      if (tag && tag !== 'latest') return tag;
      output.write('  A pre-release needs an explicit, non-\'latest\' dist-tag.\n');
    }
  };

  return {
    async bump({ name, currentVersion, publish = true }) {
      const hint = `patch=${bumpVersion(currentVersion, 'patch')} ` +
        `minor=${bumpVersion(currentVersion, 'minor')} major=${bumpVersion(currentVersion, 'major')}`;

      let type;
      for (;;) {
        const answer = await question(`  bump ${name} [${BUMP_CHOICES.join(' / ')} | <version>] (${hint}): `);
        if (BUMP_CHOICES.includes(answer) || isExplicitVersion(answer)) {
          type = answer;
          break;
        }
        output.write(`  Enter an explicit version or one of ${BUMP_CHOICES.join(', ')}.\n`);
      }

      if (type === 'skip') return 'skip';

      let preid = governedPreid ?? DEFAULT_PREID;
      let distTag;
      if (PRE_CHOICES.includes(type)) {

        // Only ask for the identifier when it isn't governed (e.g. via --preid).
        if (!governedPreid) {
          const answer = await question(`  pre-release identifier [${DEFAULT_PREID}]: `);
          if (answer) preid = answer;
        }
        output.write(`    → ${bumpVersion(currentVersion, type, preid)}\n`);

        // A dist-tag only matters for a package that is actually published.
        if (publish) distTag = await askDistTag(preid);
      } else if (isExplicitVersion(type) && isPrerelease(type)) {

        // An explicit pre-release version carries no bump identifier, but still
        // must never land on `latest` — so we still require a dist-tag, unless
        // nothing is published.
        if (publish) distTag = await askDistTag(preid);
      }

      return { type, preid, distTag };
    },

    async confirm() {
      const answer = await question('\nProceed with this release? [y/N]: ');
      return /^y(es)?$/i.test(answer);
    },

    close() {
      rl.close();
    }
  };
}

/**
 * Non-interactive prompter for CI / programmatic use. Bump decisions are taken
 * from `bumps[name]`, falling back to `bump`; each is a bump level, `skip`, or
 * an explicit version (e.g. `1.2.3`). The pre-release identifier for `pre*`
 * levels comes from `preid`; confirmation returns `yes`.
 *
 * @param {{ bumps?: Record<string, string>, bump?: string, preid?: string, yes?: boolean }} [config]
 */
export function createScriptedPrompter({ bumps = {}, bump, preid = DEFAULT_PREID, yes = false } = {}) {
  return {
    async bump({ name }) {
      const decision = name in bumps ? bumps[name] : bump;
      if (decision === 'skip') return 'skip';
      if (!BUMP_CHOICES.includes(decision) && !isExplicitVersion(decision)) {
        throw new Error(`No valid bump configured for "${name}" (got ${JSON.stringify(decision)}); expected an explicit version, one of ${BUMP_CHOICES.join(', ')}.`);
      }
      return { type: decision, preid };
    },

    async confirm() {
      return yes;
    },

    close() {}
  };
}
