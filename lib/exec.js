import spawn from 'nano-spawn';

/**
 * Create a process runner scoped to a working directory.
 *
 * The returned `run` executes a command with its arguments passed explicitly,
 * without a shell. Keeping arguments (git refs, paths, the commit message) out
 * of a shell string avoids both breakage on spaces/quotes and injection via
 * `$(...)`, backticks, etc. `nano-spawn` also resolves `npm` (a `.cmd`)
 * correctly on Windows without falling back to a shell.
 *
 * @param {string} cwd working directory the commands run in
 * @return {(file: string, args?: string[], opts?: object) => Promise<string>}
 *   resolves with the trimmed stdout of the command
 */
export function createRun(cwd) {
  return async (file, args = [], opts = {}) => {
    const { stdout } = await spawn(file, args, { cwd, ...opts });
    return stdout.trim();
  };
}
