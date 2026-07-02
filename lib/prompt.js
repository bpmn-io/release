import { createInterface } from 'node:readline';

import { bumpVersion } from './workspace.js';

const STABLE_CHOICES = [ 'patch', 'minor', 'major' ];
const PRE_CHOICES = [ 'prerelease', 'prepatch', 'preminor', 'premajor' ];
const BUMP_CHOICES = [ ...STABLE_CHOICES, ...PRE_CHOICES, 'skip' ];

/**
 * A prompter drives the interactive decisions a release needs:
 *
 *   bump({ name, currentVersion }) => 'patch' | 'minor' | 'major' | 'skip'
 *   confirm({ plan, strategy })    => boolean
 *   close()                        => void
 *
 * Inject a custom prompter into `release()` to run head-less (see
 * `createScriptedPrompter`) or to integrate with a different UI.
 */

/**
 * Interactive prompter backed by readline. The default frontend.
 *
 * `bump()` returns `{ type, preid }` — `preid` is only set for pre* bump types.
 *
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [io]
 */
export function createInteractivePrompter({ input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  const question = q => new Promise(resolve => rl.question(q, a => resolve(a.trim())));

  return {
    async bump({ name, currentVersion }) {
      const hint = `patch=${bumpVersion(currentVersion, 'patch')} ` +
        `minor=${bumpVersion(currentVersion, 'minor')} major=${bumpVersion(currentVersion, 'major')}`;

      while (true) {
        const answer = await question(
          `  bump ${name} [${BUMP_CHOICES.join(' / ')}] (${hint}): `
        );
        if (!BUMP_CHOICES.includes(answer)) {
          output.write(`  Please enter one of: ${BUMP_CHOICES.join(', ')}.\n`);
          continue;
        }

        if (!PRE_CHOICES.includes(answer)) {
          return { type: answer, preid: undefined };
        }

        const preid = (await question('  prerelease id [alpha]: ')) || 'alpha';
        output.write(`  → ${bumpVersion(currentVersion, answer, preid)}\n`);
        return { type: answer, preid };
      }
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
 * from `bumps[name]`, falling back to `bump`; confirmation returns `yes`.
 *
 * `bump()` returns `{ type, preid }` — `preid` is only meaningful for pre* bump types.
 *
 * @param {{ bumps?: Record<string, string>, bump?: string, preid?: string, yes?: boolean }} [config]
 */
export function createScriptedPrompter({ bumps = {}, bump, preid = 'alpha', yes = false } = {}) {
  return {
    async bump({ name }) {
      const decision = name in bumps ? bumps[name] : bump;
      if (!BUMP_CHOICES.includes(decision)) {
        throw new Error(`No valid bump configured for "${name}" (got ${JSON.stringify(decision)}); expected one of ${BUMP_CHOICES.join(', ')}.`);
      }
      return { type: decision, preid };
    },

    async confirm() {
      return yes;
    },

    close() {}
  };
}
