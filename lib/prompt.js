import { createInterface } from 'node:readline';

import { bumpVersion } from './workspace.js';

const BUMP_CHOICES = [ 'patch', 'minor', 'major', 'skip' ];

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
        const answer = await question(`  bump ${name} [patch / minor / major / skip] (${hint}): `);
        if (BUMP_CHOICES.includes(answer)) return answer;
        output.write('  Please enter patch, minor, major, or skip.\n');
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
 * @param {{ bumps?: Record<string, string>, bump?: string, yes?: boolean }} [config]
 */
export function createScriptedPrompter({ bumps = {}, bump, yes = false } = {}) {
  return {
    async bump({ name }) {
      const decision = name in bumps ? bumps[name] : bump;
      if (!BUMP_CHOICES.includes(decision)) {
        throw new Error(`No valid bump configured for "${name}" (got ${JSON.stringify(decision)}); expected one of ${BUMP_CHOICES.join(', ')}.`);
      }
      return decision;
    },

    async confirm() {
      return yes;
    },

    close() {}
  };
}
