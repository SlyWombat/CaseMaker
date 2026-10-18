// #477 — the old script paths still work, and the new command refuses the deferred flags.
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
  it('scripts/engrave-job.ts still prints its own usage and exits 1', () => {
    const r = run('scripts/engrave-job.ts');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('engrave-job: usage: scripts/engrave-job.ts');
  }, 120_000);

  it('scripts/feeds-readback.ts still prints its own usage and exits 1', () => {
    const r = run('scripts/feeds-readback.ts');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('feeds-readback: usage: scripts/feeds-readback.ts');
  }, 120_000);

  it('scripts/run-readback.ts still prints its own usage and exits 1', () => {
    const r = run('scripts/run-readback.ts');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('run-readback: usage: scripts/run-readback.ts');
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

  it('refuses --json with #478 named, before a command can run', () => {
    const r = run('scripts/casemaker.ts', ['engrave', 'docs/bench/single-barrel.job.json', '--json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('#478');
    expect(r.stderr).toContain('not available yet');
  }, 120_000);

  it('refuses machine commands with #479 named and touches nothing', () => {
    const r = run('scripts/casemaker.ts', ['machine', 'status']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('#479');
    expect(r.stderr).toContain('nothing was sent to the machine or the network');
  }, 120_000);
});
