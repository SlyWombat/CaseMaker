/**
 * #1014 — THE FINISH MASK'S LEFTOVER IS WHAT THE ROUGH ACTUALLY LEFT, not its cutter's ideal CL.
 *
 * `roughLeftAbove` (next to `depthPasses` in `ops/rough.ts`) is the one place the rough's two
 * outputs are turned into a standing surface: the CL where its band skim could cut, else the
 * first Z-level at or above `cl + band`, else the stock top (nothing cuts). The finish's mask
 * (`plan.ts`'s `leftoverAbove`) admits a point when that surface stands more than the finish band
 * above the design. These cases are the rule, red at f73deb58's CL-only read.
 */
import { describe, expect, it } from 'vitest';

import { depthPasses, roughLeftAbove } from '@/engine/cnc/cam/model/ops/rough';

const Z_TOP = 0;
const Z_BOTTOM = -2;
const STEP = 0.3;
const BAND = 0.3;
const FINISH_BAND = 0.027;
const admitted = (cl: number, design: number): boolean =>
  roughLeftAbove(cl, Z_TOP, Z_BOTTOM, STEP, BAND) - design > FINISH_BAND;

describe('#1014 — roughLeftAbove', () => {
  it('a ball rough on a 5.7° slope: the ⌀1 ball’s CL is 0.0025 above the design, but below the skim zone the rough leaves its level terrace — admitted', () => {
    for (const design of [-0.6, -1.0, -1.4, -1.8]) {
      const cl = design + 0.0025; // R(1/cos θ − 1) for R = 0.5 at 5.7°
      // The old CL-only read: 0.0025 < 0.027 → skipped. The terrace is at least one band above.
      expect(cl - design).toBeLessThan(FINISH_BAND);
      const left = roughLeftAbove(cl, Z_TOP, Z_BOTTOM, STEP, BAND);
      // The floor is the first level at or above cl + band, so the terrace stands band…band+step.
      expect(left - design).toBeGreaterThanOrEqual(BAND - 1e-9);
      expect(left - design).toBeLessThanOrEqual(BAND + STEP + 1e-9);
      expect(admitted(cl, design), `design ${design}`).toBe(true);
    }
    // Above the first level (cl >= zTop − step) the skim cuts to the CL: at design −0.2 the same
    // ball leaves 0.0025 mm, and nothing is admitted — the rough really did finish that ground.
    expect(admitted(-0.1975, -0.2)).toBe(false);
  });

  it('a flat rough on a 0.3° plane: the flat’s CL (R·tan θ = 0.016) is under the band, but its terrace is not — admitted', () => {
    const design = -0.8;
    const cl = design + 3 * Math.tan((0.3 * Math.PI) / 180); // ⌀6 flat: R = 3
    expect(cl - design).toBeLessThan(FINISH_BAND); // the old read skipped this ground
    expect(admitted(cl, design)).toBe(true);
  });

  it('a skimmed cell cuts to the CL — nothing is left, so it is NOT admitted (the cards’ behaviour kept)', () => {
    // The skim's zone: cl < zTop and cl >= the first level (zTop − step here).
    const design = -0.1;
    const cl = design; // the skim cuts exactly to the CL
    const left = roughLeftAbove(cl, Z_TOP, Z_BOTTOM, STEP, BAND);
    expect(left).toBe(cl);
    expect(admitted(cl, design)).toBe(false);
  });

  it('between the skim zone and the first cutting level nothing cuts: the stock top stands, and the band admits it', () => {
    // cl + band lands above the first level (so no level cuts), and cl is below the skim's zone.
    const design = -0.45;
    const cl = design + 0.0025;
    const left = roughLeftAbove(cl, Z_TOP, Z_BOTTOM, STEP, BAND);
    expect(left).toBe(Z_TOP);
    expect(admitted(cl, design)).toBe(true);
  });

  it('a flush cell at the stock top is not a cut and not a leftover', () => {
    expect(roughLeftAbove(0, Z_TOP, Z_BOTTOM, STEP, BAND)).toBe(Z_TOP);
    expect(admitted(0, 0)).toBe(false);
  });

  it('a region shallower than one step-down: the single level IS the first level, so the skim covers the whole region', () => {
    const levels = depthPasses(0, -0.2, STEP);
    expect(levels).toEqual([-0.2]);
    expect(roughLeftAbove(-0.1, 0, -0.2, STEP, BAND)).toBe(-0.1); // the skim's exact cut
  });
});
