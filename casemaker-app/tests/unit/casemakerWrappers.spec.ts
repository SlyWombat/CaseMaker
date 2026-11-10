// #477 — the old script paths still work, and the new command owns its flags: `--json` the
// receipt switch (#478), and the machine subcommands, which refuse an unknown target without a
// socket (their own spec drives the transport).
//
// These are process-level smoke tests: each old entry point or `casemaker` invocation must reach
// its own usage/refusal and exit with the documented code. They are spawn-based because that is the
// property being tested (the path a bench user types), and they are deliberately argument errors so
// no wasm initialisation, file write or hardware access happens.
//
// #1180 — THE STARTUPS OVERLAP. Each test's 1–4 s was tsx starting a process, not the command, and
// seven starts ran one after another. `beforeAll` starts all seven together; each test awaits its
// own result and asserts exactly what it did before. A start that fails rejects only its own test.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const require = createRequire(import.meta.url);
const TSX = pathToFileURL(require.resolve('tsx')).href;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Start one script now; the promise settles on its exit. */
function start(script: string, args: string[] = []): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.scripts.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Every case this spec starts, keyed by the test that awaits it. */
const CASES: readonly (readonly [key: string, script: string, args: string[]])[] = [
  ['legacy-cut', 'scripts/engrave-job.ts', []],
  ['legacy-feeds', 'scripts/feeds-readback.ts', []],
  ['legacy-run', 'scripts/run-readback.ts', []],
  ['help', 'scripts/casemaker.ts', ['--help']],
  ['json-anywhere', 'scripts/casemaker.ts', ['--json', '--help']],
  ['json-value', 'scripts/casemaker.ts', ['engrave', 'docs/bench/single-barrel.job.json', '--json=true']],
  [
    'machine-no-address',
    'scripts/casemaker.ts',
    ['machine', 'status', '--location', 'tests/unit/fixtures/no-such-location.json'],
  ],
];

const running = new Map<string, Promise<Run>>();
beforeAll(() => {
  for (const [key, script, args] of CASES) running.set(key, start(script, args));
});
const result = (key: string): Promise<Run> => running.get(key)!;

describe('#477 the old script paths remain entry points', () => {
  // The legacy paths share the body's `fail()` and USAGE, so since #484 they report the command
  // they now route to — the spec still proves the old path runs.
  it('scripts/engrave-job.ts still runs and prints the command usage, exiting 1', async () => {
    const r = await result('legacy-cut');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('casemaker cut: usage: casemaker cut');
  }, 120_000);

  it('scripts/feeds-readback.ts still runs and prints the command usage, exiting 1', async () => {
    const r = await result('legacy-feeds');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('casemaker readback feeds: usage: casemaker readback feeds');
  }, 120_000);

  it('scripts/run-readback.ts still runs and prints the command usage, exiting 1', async () => {
    const r = await result('legacy-run');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('casemaker readback run: usage: casemaker readback run');
  }, 120_000);
});

describe('#477 the casemaker entry point', () => {
  it('prints the command list for --help and exits 0', async () => {
    const r = await result('help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage: casemaker <command>');
    expect(r.stdout).toContain('casemaker engrave');
    expect(r.stdout).toContain('casemaker location');
    expect(r.stdout).toContain('casemaker readback');
  }, 120_000);

  it('accepts --json anywhere on the line as the receipt switch (#478)', async () => {
    // `--help` short-circuits before a handler, so this proves the strip without starting the
    // wasm-bearing pipeline; the receipt itself is covered by the unit specs.
    const r = await result('json-anywhere');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage: casemaker <command>');
    expect(r.stdout).toContain('With `--json`, stdout is');
  }, 120_000);

  it('refuses a value on --json before a command can run', async () => {
    const r = await result('json-value');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--json takes no value');
    expect(r.stderr).toContain('nothing was run');
  }, 120_000);

  it('refuses a machine command with no address before opening a socket', async () => {
    const r = await result('machine-no-address');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no machine address — pass --host');
  }, 120_000);
});
