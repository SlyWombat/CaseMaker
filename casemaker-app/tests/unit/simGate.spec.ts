// #393: an error-severity simulation diagnostic, and the question `ok` does not answer.
//
// The trap this file pins is a semantic one. `SimLoadResult.ok` means "the sweep produced
// material" — deliberately, because the Simulate panel's job is to DRAW a cut that drove the
// cutter into the jaw, and `SimLoadRefused` carries no meshes (#194). So a program that hits the
// fixture arrives as `ok: true` WITH a `tool-into-fixture` error, and every caller that reads `ok`
// as "this program is safe to write" is wrong. That is exactly what happened to the bench coupons
// (`scripts/engrave-job.ts`, #393), so the two questions got their own names in
// `engine/cnc/simGate.ts`.
//
// Here the two answers are shown to come apart on REAL geometry — a stroke whose edge leaves the
// stock and cuts the fixed jaw, the #182 must-fail case from `cncSweep.spec.ts`. Whether that
// refusal then keeps a file off the disk is `engraveJobGate.spec.ts`'s business: this spec would
// pass with the guard deleted, so it is not the regression test for #393 on its own.

import { describe, it, expect } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { createSimSession, type SimDiagnostic } from '@/workers/sim/session';
import { simErrors, simulationProblem } from '@/engine/cnc/simGate';
import { stubSetup, viseEnvelope, DEFAULT_VISE, type Setup } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';
import { rectProfile } from '@/engine/compiler/profile';

// 100 × 60 × 12, the default job's blank (the same fixture as `cncSweep.spec.ts` §#204): the work
// origin is its top-front-left, so the stock is X 0..100, Y 0..60, Z −12..0 and cuts are −Z. The
// jaws span Y −10..70 and their tops sit at Z = −4.
const SLAB = { kind: 'prism' as const, outline: rectProfile(100, 60), thickness: 12 };
const STOCK = { length: 100, width: 60, thickness: 12 };
const HOLD = { kind: 'tape-down' as const, contact: SLAB.outline };
const fixtureSetup = (): Setup =>
  stubSetup(SLAB, HOLD, { fixture: viseEnvelope(STOCK, { ...DEFAULT_VISE, uncertainty: 0 }) });

/** A 3.175 mm flat end mill — radius 1.5875, so its edge reaches 0.59 mm past X = 0. */
const TOOL = flatEndMill(3.175);

/**
 * One stroke in Y from 10 to 50 at a constant X, then clear. At X = 1.0 the edge is 0.59 mm
 * OUTSIDE the stock's left face and 5 mm below the jaw tops: it cuts the fixed jaw. At X = 10 it
 * is well inside the stock, at 1 mm deep.
 */
const stroke = (x: number, z: number): string => `S1000 M3\nG0 X${x} Y10 Z1\nG1 Z${z} F100\nG1 Y50\n`;

function load(text: string) {
  const session = createSimSession(tl);
  const r = session.load(text, fixtureSetup(), TOOL, null);
  session.dispose();
  return r;
}

describe('#393: the simulation error is not the `ok` flag', () => {
  it('is `ok: true` with a fixture ERROR in its diagnostics — the panel has to be able to draw it', () => {
    const r = load(stroke(1.0, -5));
    expect(r.ok).toBe(true);
    const hit = r.diagnostics.find((d) => d.code === 'tool-into-fixture');
    expect(hit?.severity).toBe('error');
    expect(hit?.message).toContain('Vise fixed jaw');
    // The safety answer, which is a different one:
    expect(simErrors(r.diagnostics).length).toBeGreaterThan(0);
    expect(simulationProblem(r.diagnostics)).toContain('tool-into-fixture');
  });

  it('leaves `simulationProblem` null for a clean program, and for warnings alone', () => {
    const clean = load(stroke(10, -1));
    expect(clean.ok).toBe(true);
    expect(simErrors(clean.diagnostics)).toEqual([]);
    expect(simulationProblem(clean.diagnostics)).toBeNull();
    // A warning is not a refusal: the run sheet carries it, the operator decides.
    const warned: SimDiagnostic[] = [{ source: 'sweep', severity: 'warning', code: 'vise-default', message: 'unmeasured' }];
    expect(simulationProblem(warned)).toBeNull();
    expect(simulationProblem([])).toBeNull();
  });

  it('NAMES every error and where it was raised, rather than counting them (#393)', () => {
    const diags: SimDiagnostic[] = [
      { source: 'sweep', severity: 'error', code: 'tool-into-fixture', message: 'checkpoint 0: …', checkpoint: 0 },
      { source: 'sweep', severity: 'warning', code: 'vise-default', message: 'unmeasured' },
      { source: 'sweep', severity: 'error', code: 'tool-into-fixture', message: 'checkpoint 1: …', checkpoint: 1 },
      { source: 'runner', severity: 'error', code: 'feed-too-fast', message: '…', line: 12 },
    ];
    expect(simErrors(diags).map((d) => d.code)).toEqual(['tool-into-fixture', 'tool-into-fixture', 'feed-too-fast']);
    expect(simulationProblem(diags)).toBe(
      '3 simulation errors: tool-into-fixture at checkpoint 0; tool-into-fixture at checkpoint 1; feed-too-fast at line 12',
    );
  });
});
