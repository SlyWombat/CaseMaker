// #393 — the guard, driven through the REAL producer of the bench coupons.
//
// `scripts/engrave-job.ts` wrote four 11.5 mm #284 coupons whose own simulation said the cutter was
// 2.2–3.4 mm³ inside the fixed jaw, and receipted them "all generated": it gated on `load.ok`,
// which means "the sweep produced material" and not "the program is safe" (`simGate.ts`). The
// refusal is three lines in that script, so the only honest test of it is the script itself.
//
// It runs `tsx scripts/engrave-job.ts --coupon …` as a subprocess (≈5 s per coupon: tsx boot,
// generation, one sweep) and reads the directory afterwards. Both directions are checked, because
// a gate that refuses everything would pass the refusal half on its own: the same script, the same
// base job, a size the app accepts must still write its program.
//
// The base job is the bench's own committed blank (`docs/bench/165-depth-ladder-row-A.job.json`).
// If its geometry ever moves so that 11.5 mm no longer reaches the jaw this test FAILS rather than
// silently proving nothing — that is loud and right, and the fix is to re-derive both sizes from
// the blank.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = join(APP, 'node_modules', 'tsx', 'dist', 'cli.mjs');
/** The rear clear band of the as-clamped badge blank — where the bench's own #284 coupon sits. */
const BASE_JOB = join(APP, '..', 'docs', 'bench', '165-depth-ladder-row-A.job.json');

/**
 * Run `scripts/engrave-job.ts --coupon` on a coupon spec at `text.size` and return what it said,
 * plus what it left in the output directory (the directory holds only produced files: the spec
 * itself is written one level up).
 */
function runCoupon(textSize: number, id: string): { status: number | null; output: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), `casemaker-393-${id}-`));
  const outDir = join(root, 'out');
  mkdirSync(outDir);
  const specPath = join(root, 'spec.json');
  writeFileSync(
    specPath,
    JSON.stringify({
      id,
      title: `393 ${id}`,
      parameter: 'feed',
      values: [500],
      basePath: BASE_JOB,
      text: { size: textSize, pitch: 16 },
      origin: { x: 19.05, y: 68 },
      depth: 0.8,
      font: 'sans-default',
      weight: 'bold',
    }),
  );
  // `process.execPath` + tsx's own CLI, rather than `npx`: no shell, so the space in this repo's
  // path needs no quoting, and no `.cmd` shim has to be found.
  const run = spawnSync(
    process.execPath,
    [TSX, '--tsconfig', 'tsconfig.scripts.json', 'scripts/engrave-job.ts', '--coupon', specPath, '--out', outDir],
    { cwd: APP, encoding: 'utf8', timeout: 120_000 },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}`, files: readdirSync(outDir).sort() };
}

describe('#393: a job the simulation refuses is not written', () => {
  it('refuses an 11.5 mm coupon whose cutter reaches the jaw, and writes no program', () => {
    const { status, output, files } = runCoupon(11.5, '393-regression');
    expect(status).toBe(1);
    // Named, not counted: the operator reads WHY, and where the sweep saw it.
    expect(output).toContain('tool-into-fixture');
    expect(output).toContain('the cutter drives');
    expect(output).toMatch(/2 simulation errors: tool-into-fixture at checkpoint 0/);
    expect(output).toContain('SOME STOPPED');
    // Nothing for the machine, and no run sheet to carry it: the coupon record is the only file,
    // and it has no rows, because a job that was refused is not a row to cut.
    expect(files).toEqual(['393-regression-coupon-record.json']);
    expect(output).toContain('0 row(s) to complete');
  });

  it('still writes the program for a coupon the app accepts — the gate is not a blanket refusal', () => {
    const { status, output, files } = runCoupon(11, '393-control');
    expect(status).toBe(0);
    expect(output).toContain('all generated');
    // The program, its frame (§6's dry run) and its sheet, as `runJob` promises.
    expect(files.filter((f) => f.endsWith('.nc') && !f.endsWith('-frame.nc'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('-frame.nc'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('-run-sheet.md'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.job.json'))).toHaveLength(1);
  });
});
