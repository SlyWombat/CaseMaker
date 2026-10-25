// #477 — the old script paths still work, and the new command owns its flags: `--json` the
// receipt switch (#478), and the machine subcommands, which refuse an unknown target without a
// socket (their own spec drives the transport).
//
// These are process-level smoke tests: each old entry point or `casemaker` invocation must reach
// its own usage/refusal and exit with the documented code. They are spawn-based because that is the
// property being tested (the path a bench user types), and they are deliberately argument errors so
// no wasm initialisation, file write or hardware access happens.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const require = createRequire(import.meta.url);
const TSX = pathToFileURL(require.resolve('tsx')).href;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[] = []): Run {
  const res = spawnSync(process.execPath, ['--import', TSX, join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.scripts.json') },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('#477 the old script paths remain entry points', () => {
  // The legacy paths share the body's `fail()` and USAGE, so since #484 they report the command
  // they now route to — the spec still proves the old path runs.
  it('scripts/engrave-job.ts still runs and prints the command usage, exiting 1', () => {
    const r = run('scripts/engrave-job.ts');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('casemaker cut: usage: casemaker cut');
  }, 120_000);

  it('scripts/feeds-readback.ts still runs and prints the command usage, exiting 1', () => {
    const r = run('scripts/feeds-readback.ts');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('casemaker readback feeds: usage: casemaker readback feeds');
  }, 120_000);

  it('scripts/run-readback.ts still runs and prints the command usage, exiting 1', () => {
    const r = run('scripts/run-readback.ts');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('casemaker readback run: usage: casemaker readback run');
  }, 120_000);
});

describe('#477 the casemaker entry point', () => {
  it('prints the command list for --help and exits 0', () => {
    const r = run('scripts/casemaker.ts', ['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage: casemaker <command>');
    expect(r.stdout).toContain('casemaker engrave');
    expect(r.stdout).toContain('casemaker location');
    expect(r.stdout).toContain('casemaker readback');
  }, 120_000);

  it('accepts --json anywhere on the line as the receipt switch (#478)', () => {
    // `--help` short-circuits before a handler, so this proves the strip without starting the
    // wasm-bearing pipeline; the receipt itself is covered by the unit specs.
    const r = run('scripts/casemaker.ts', ['--json', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage: casemaker <command>');
    expect(r.stdout).toContain('With `--json`, stdout is');
  }, 120_000);

  it('refuses a value on --json before a command can run', () => {
    const r = run('scripts/casemaker.ts', ['engrave', 'docs/bench/single-barrel.job.json', '--json=true']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--json takes no value');
    expect(r.stderr).toContain('nothing was run');
  }, 120_000);

  it('refuses a machine command with no address before opening a socket', () => {
    const r = run('scripts/casemaker.ts', ['machine', 'status', '--location', 'tests/unit/fixtures/no-such-location.json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no machine address — pass --host');
  }, 120_000);
});
