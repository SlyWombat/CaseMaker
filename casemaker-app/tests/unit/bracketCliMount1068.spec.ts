/**
 * #1068 — A BRACKET JOB IS CHECKED AGAINST ITS OWN MOUNT, THROUGH BOTH DOORS.
 *
 * The app's Generate derived the bracket's obstacles (`bracketMount`: the two arms, the job's
 * clamps, the fit) and handed them to the verifier and the sweep. The command line did not: its
 * shop carried no `mount` and its sweep loaded `toSetup(job, Z1)` with NO fixture at all — so a
 * bracket job's program was planned against nothing, swept against nothing, and handed a run sheet
 * whose first section said "Mount the vise". The M1 tray is held in the bracket (Issue #1068).
 *
 * RED at the pre-change tree: the cut under the job's clamp runs clean, the cut over an obstacle
 * box the job states is never seen, and the run sheet says "Mount the vise". GREEN here: the
 * clamp is refused `clamp-in-path`, a cut into the hole box is refused `tool-into-fixture` naming
 * it, and the sheet is the bracket's own.
 *
 * The mount's sizes come from the fixture location's own defaults (`tests/unit/fixtures/
 * location-doc.json`: `bracket.heightMm` 10, `clamps.top*` reach 8 / width 15 / height 12, fit
 * 0.1), exactly as the app reads them from its location.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import type { CommandOptions } from '../../scripts/lib/casemaker/output';
import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import type { Receipt } from '../../src/platform/headless/receipt';
import type { EngraveJob, EngraveShape } from '../../src/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');
/** The fixture location's 2 mm owned flat (the badge job's own cutter). */
const CUTTER = 'user:1a2b3c4d5e';
const NOW = new Date('2026-11-07T12:00:00.000Z');

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-bracket-1068-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface CutRun {
  code: number;
  receipt: Receipt | null;
  outDir: string;
  progress: string[];
}

/**
 * The box the job states, in the work frame — the field #1068 adds to `BracketHold` (`obstacles`).
 * Stated here rather than imported so this spec compiles at the PRE-change tree, where the type
 * does not exist yet and the schema strips the field: that is the red run.
 */
interface JobBox {
  id: string;
  label: string;
  min: [number, number, number];
  max: [number, number, number];
}

async function cut(job: EngraveJob, name: string): Promise<CutRun> {
  const outDir = join(SCRATCH, name);
  mkdirSync(outDir, { recursive: true });
  const jobPath = join(outDir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + '\n');
  let receipt: Receipt | null = null;
  const progress: string[] = [];
  const options: CommandOptions = {
    json: true,
    now: NOW,
    sink: {
      progress: (line) => progress.push(line),
      receipt: (r) => {
        receipt = r;
      },
    },
  };
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', LOCATION], options);
  return { code, receipt, outDir, progress };
}

/** A rect pocket — deterministic toolpath, placed in the test's own XY. */
function pocket(id: string, x: number, y: number, width: number, height: number, depth: number): EngraveShape {
  return {
    id,
    kind: 'rect',
    position: { x, y },
    rotation: 0,
    depth,
    enabled: true,
    width,
    height,
    cornerRadius: 0,
  };
}

/**
 * A 100 × 100 × 12 hardwood job in the bracket. The job states its OWN clamp places, so the test
 * does not depend on the QuickStart's default pair; the clamp SIZES are the location's.
 */
function bracketJob(opts: {
  shape: EngraveShape;
  clamps: { edge: 'back' | 'right'; at: number }[];
  obstacles?: JobBox[];
}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'bracket mount 1068',
    stock: { ...base.stock, length: 100, width: 100, thickness: 12, material: 'hardwood' },
    labels: [],
    shapes: [opts.shape],
    toolKey: CUTTER,
    workholding: {
      kind: 'bracket',
      bracket: {
        anchor: 1,
        variant: 'thin',
        clamps: opts.clamps,
        ...(opts.obstacles === undefined ? {} : { obstacles: opts.obstacles }),
        source: 'default',
      },
    },
  };
}

function diagnosticsOf(run: CutRun): { code: string; message: string }[] {
  return (run.receipt?.diagnostics ?? []).map((d) => ({ code: d.code, message: d.message }));
}

describe('#1068 a bracket job through the command line is checked against its mount', () => {
  it('a cut under the job’s clamp is refused clamp-in-path, naming the clamp', async () => {
    // The clamp footprint (location defaults): 15 mm wide, 8 mm reach in over the back edge,
    // 12 mm above the stock top. Centred at X 50, it stands over Y 92..122 and X 42.5..57.5, and
    // the pocket runs Z -1 under it.
    const job = bracketJob({
      shape: pocket('under-clamp', 50, 95, 20, 6, 1),
      clamps: [{ edge: 'back', at: 50 }],
    });
    const run = await cut(job, 'under-clamp');
    const diags = diagnosticsOf(run);
    const hit = diags.find((d) => d.code === 'clamp-in-path');
    expect(
      hit,
      JSON.stringify({ code: run.code, refusals: run.receipt?.refusals ?? null, diagnostics: diags }, null, 2),
    ).toBeDefined();
    expect(hit!.message).toContain('the clamp on the back edge');
    expect(hit!.message).toContain('runs under');
    expect(run.code).not.toBe(0);
  }, 300_000);

  it('a cut into a hole box the JOB states is refused tool-into-fixture, naming it', async () => {
    // The tray's two counterbored holes sit in the LEFT waste. This box is the hole up to the
    // counterbore's floor (Z -2), so a pocket cut to Z -4 passes through the screw head's space.
    const HOLE: JobBox = {
      id: 'hole-1',
      label: 'the counterbored hole, 8 mm in from the left edge',
      min: [8, 38, -12],
      max: [15, 44, -2],
    };
    const job = bracketJob({
      shape: pocket('over-hole', 11, 41, 8, 8, 4),
      // The clamps are nowhere near the hole: this refusal is the BOX's, not a clamp's.
      clamps: [{ edge: 'back', at: 90 }],
      obstacles: [HOLE],
    });
    const run = await cut(job, 'over-hole');
    const diags = diagnosticsOf(run);
    const hit = diags.find((d) => d.code === 'tool-into-fixture');
    expect(
      hit,
      JSON.stringify({ code: run.code, refusals: run.receipt?.refusals ?? null, diagnostics: diags }, null, 2),
    ).toBeDefined();
    expect(hit!.message).toContain('the counterbored hole, 8 mm in from the left edge');
    expect(hit!.message).toContain('hole-1');
    expect(run.code).not.toBe(0);
    // The refusal is the BOX's: neither arm nor clamp is anywhere near this cut.
    expect(diags.some((d) => d.code === 'clamp-in-path' || d.code === 'bracket-in-path')).toBe(false);
  }, 300_000);

  it('the run sheet is the bracket’s own — its steps, not "Mount the vise"', async () => {
    const job = bracketJob({
      shape: pocket('clear', 50, 50, 20, 10, 1),
      clamps: [{ edge: 'back', at: 90 }],
    });
    const run = await cut(job, 'sheet');
    expect(
      run.code,
      JSON.stringify({ refusals: run.receipt?.refusals ?? null, diagnostics: diagnosticsOf(run) }, null, 2),
    ).toBe(0);
    if (run.receipt === null || run.receipt.command !== 'engrave') throw new Error('expected the engrave receipt');
    const sheetFile = run.receipt.details.programs[0]!.sheet?.file;
    expect(sheetFile, 'the run carries a sheet').toBeTruthy();
    const sheet = readFileSync(join(run.outDir, sheetFile!), 'utf8');

    expect(sheet).toContain('Fit the bracket');
    expect(sheet).not.toContain('Mount the vise');
    // The top-view picture is the mount's too: no vise jaws beside a bracket sheet.
    expect(sheet).not.toContain('vise-fixed-jaw');
    expect(sheet).not.toContain('vise-moving-jaw');
    expect(sheet).toContain('Top view of the stock and the work origin');
    expect(sheet).toContain('Pin the bracket to the bed at anchor 1');
    expect(sheet).toContain("front-left corner into the bracket's inside corner at anchor 1");
    // The job's own clamp place, in the sheet's words.
    expect(sheet).toContain('Fit a top clamp on the back edge, its centre 90 mm from the left end');
  }, 300_000);

  it('a VISE job still gets the vise section — the branch reads the mount, it does not remove it', async () => {
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      name: 'vise sheet 1068',
      labels: [],
      shapes: [pocket('clear', 50, 30, 20, 10, 1)],
      toolKey: CUTTER,
    };
    const run = await cut(job, 'vise-sheet');
    expect(
      run.code,
      JSON.stringify({ refusals: run.receipt?.refusals ?? null, diagnostics: diagnosticsOf(run) }, null, 2),
    ).toBe(0);
    if (run.receipt === null || run.receipt.command !== 'engrave') throw new Error('expected the engrave receipt');
    const sheet = readFileSync(join(run.outDir, run.receipt.details.programs[0]!.sheet!.file!), 'utf8');
    expect(sheet).toContain('Mount the vise');
    expect(sheet).not.toContain('Fit the bracket');
  }, 300_000);
});
