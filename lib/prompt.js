import { createInterface } from 'node:readline';

import { bumpVersion } from './workspace.js';

const STABLE_CHOICES = [ 'patch', 'minor', 'major' ];
const PRE_CHOICES = [ 'premajor', 'preminor', 'prepatch', 'prerelease' ];
const BUMP_CHOICES = [ ...STABLE_CHOICES, ...PRE_CHOICES, 'skip' ];

const DEFAULT_PREID = 'alpha';

/**
 * A prompter drives the interactive decisions a release needs:
 *
 *   bump({ name, currentVersion }) => { type, preid, distTag } | 'skip'
 *   confirm({ plan, strategy })    => boolean
 *   close()                        => void
 *
 * `bump()` resolves to `'skip'` to leave a package out, or to a
 * `{ type, preid, distTag }` decision where `type` is one of
 * `patch | minor | major | premajor | preminor | prepatch | prerelease`,
 * `preid` (the pre-release identifier, e.g. `alpha`) applies to the `pre*`
 * types, and `distTag` is the npm dist-tag chosen for a `pre*` bump (never
 * `latest`; `undefined` for a stable bump, which defaults to `latest`).
 *
 * Inject a custom prompter into `release()` to run head-less (see
 * `createScriptedPrompter`) or to integrate with a different UI.
 */

/**
 * Interactive prompter backed by readline. The default frontend.
 *
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, defaultPreid?: string, defaultDistTag?: string }} [io]
 */
export function createInteractivePrompter({ input = process.stdin, output = process.stdout, defaultPreid = DEFAULT_PREID, defaultDistTag } = {}) {
  const rl = createInterface({ input, output });
  const question = q => new Promise(resolve => rl.question(q, a => resolve(a.trim())));

  // A pre-release must never publish to `latest`, so keep asking until we get a
  // non-empty, non-`latest` dist-tag. Defaults to the CLI-provided dist-tag when
  // present, otherwise the identifier itself (e.g. `alpha` → tag `alpha`).
  const askDistTag = async (preid) => {
    const fallback = defaultDistTag ?? preid;
    for (;;) {
      const answer = await question(`  npm dist-tag (never 'latest') [${fallback}]: `);
      const tag = answer || fallback;
      if (tag && tag !== 'latest') return tag;
      output.write('  A pre-release needs an explicit, non-\'latest\' dist-tag.\n');
    }
  };

  return {
    async bump({ name, currentVersion }) {
      const hint = `patch=${bumpVersion(currentVersion, 'patch')} ` +
        `minor=${bumpVersion(currentVersion, 'minor')} major=${bumpVersion(currentVersion, 'major')}`;

      let type;
      for (;;) {
        const answer = await question(`  bump ${name} [${BUMP_CHOICES.join(' / ')}] (${hint}): `);
        if (BUMP_CHOICES.includes(answer)) {
          type = answer;
          break;
        }
        output.write(`  Please enter one of ${BUMP_CHOICES.join(', ')}.\n`);
      }

      if (type === 'skip') return 'skip';

      let preid = defaultPreid;
      let distTag;
      if (PRE_CHOICES.includes(type)) {
        const answer = await question(`  pre-release identifier [${defaultPreid}]: `);
        if (answer) preid = answer;
        output.write(`    → ${bumpVersion(currentVersion, type, preid)}\n`);
        distTag = await askDistTag(preid);
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
 * from `bumps[name]`, falling back to `bump`; the pre-release identifier for
 * `pre*` bumps comes from `preid`; confirmation returns `yes`.
 *
 * @param {{ bumps?: Record<string, string>, bump?: string, preid?: string, yes?: boolean }} [config]
 */
export function createScriptedPrompter({ bumps = {}, bump, preid = DEFAULT_PREID, yes = false } = {}) {
  return {
    async bump({ name }) {
      const decision = name in bumps ? bumps[name] : bump;
      if (decision !== 'skip' && !BUMP_CHOICES.includes(decision)) {
        throw new Error(`No valid bump configured for "${name}" (got ${JSON.stringify(decision)}); expected one of ${BUMP_CHOICES.join(', ')}.`);
      }
      return decision === 'skip' ? 'skip' : { type: decision, preid };
    },

    async confirm() {
      return yes;
    },

    close() {}
  };
}
