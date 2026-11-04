/**
 * #964 — HOW A TEST SPAWNS A TSX SCRIPT, ON EVERY OS.
 *
 * `npx.cmd` without `shell: true` is refused on Windows on Node >= 20.12 (B hit it running
 * `clParity.spec` on `957-cl-surface`; the check script passed 21/21 when run by hand, the spec's
 * spawned test failed with EINVAL). Spawning the CURRENT Node binary with tsx's own CLI entry
 * avoids both the `.cmd` shim and the shell: the same argv works on Linux, macOS and Windows, with
 * no quoting, no PATH lookup, and no `shell: true` (which would reintroduce platform quoting for
 * paths that can contain spaces).
 *
 * `require.resolve('tsx/cli')` is tsx's own published entry (`dist/cli.mjs`, listed in the
 * package's `bin` and `exports`), so this follows the installed version rather than guessing a
 * path.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Absolute path to tsx's CLI entry, e.g. `<app>/node_modules/tsx/dist/cli.mjs`. */
export const TSX_CLI: string = require.resolve('tsx/cli');

/**
 * The argv that runs one TS script under tsx, for `spawnSync`/`execFileSync` with
 * `process.execPath` as the command.
 */
export function tsxArgs(script: string, args: readonly string[] = [], tsconfig = 'tsconfig.scripts.json'): string[] {
  return [TSX_CLI, '--tsconfig', tsconfig, script, ...args];
}
