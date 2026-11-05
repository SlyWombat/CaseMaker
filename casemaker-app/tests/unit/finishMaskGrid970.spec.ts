/**
 * #970 — THE FINISH MASK'S RED-FIRST: a steep-flank grid where the exact rule keeps a point and
 * the old `Math.round` read drops it.
 *
 * The mask's leftover grid samples the flat's CL at its own pitch. `cd5ec056` read it with ONE
 * rounded cell per point; on the panther's 74–89° flanks the CL varies between samples, the
 * rounded cell said "no leftover" where the exact per-point query said leftover, and the finish
 * stopped running there (coverage 73.17 → 49.09 %). The fix reads the point's floor/ceil pair in
 * each axis; over-inclusion is allowed, a dropped point is the bug.
 *
 * RED-FIRST, precisely: `leftoverRounded` (the pre-fix read) is FALSE at the point this case
 * builds, `leftoverNear` (the fix) is TRUE, and the point sits exactly between two samples — the
 * half-cell tie that `Math.round` resolves upward, away from the leftover cell.
 */

import { describe, expect, it } from 'vitest';

import { leftoverNear, leftoverRounded, maskCellsConservative, type LeftoverGrid } from '@/engine/cnc/cam/model/maskGrid';

/** A 4x4 grid at 0.5 mm; the leftover cells are listed by (i, j). */
const grid = (leftover: readonly [number, number][]): LeftoverGrid => {
  const nx = 4;
  const ny = 4;
  const cells = new Uint8Array(nx * ny);
  for (const [i, j] of leftover) cells[j * nx + i] = 1;
  return { nx, ny, min: [0, 0], pitch: 0.5, cells };
};

describe('#970 the finish mask reads its leftover grid conservatively', () => {
  it('RED-FIRST: a point exactly between two samples keeps the leftover the rounded read drops', () => {
    // The steep flank: cell (0, 1) is leftover, cell (1, 1) is not — the CL falls across the rise.
    const g = grid([[0, 1]]);
    // x = 0.25 mm sits at fx = 0.5 between cell 0 and cell 1: Math.round(HALF UP) picks cell 1
    // and misses the leftover at cell 0 — the pre-fix mask returned false here.
    expect(leftoverRounded(g, 0.25, 0.75)).toBe(false);
    // The fix: the floor/ceil pair touches cell 0, so the point is leftover.
    expect(leftoverNear(g, 0.25, 0.75)).toBe(true);
  });

  it('the mask keeps a ball footprint point whose ring lands between samples', () => {
    const g = grid([[0, 1]]);
    const ring: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1], [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]];
    // A point whose OWN cell is clean but whose -x ring point (x = 0.25) touches the leftover.
    expect(maskCellsConservative(g, ring, 1.25, 0.75)).toBe(true);
  });

  it('never drops a point the rounded read keeps — inclusion is monotone', () => {
    const g = grid([[0, 0], [2, 3], [3, 1]]);
    for (let x = -0.5; x <= 2.0; x += 0.05) {
      for (let y = -0.5; y <= 2.0; y += 0.05) {
        if (leftoverRounded(g, x, y)) expect(leftoverNear(g, x, y), `(${x.toFixed(2)}, ${y.toFixed(2)})`).toBe(true);
      }
    }
  });

  it('a point nowhere near a leftover cell is not included', () => {
    const g = grid([[3, 3]]);
    expect(leftoverNear(g, 0.1, 0.1)).toBe(false);
    expect(maskCellsConservative(g, [[1, 0]], 0.1, 0.1)).toBe(false);
  });
});
