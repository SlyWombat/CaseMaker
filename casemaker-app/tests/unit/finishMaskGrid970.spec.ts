/**
 * #970 — THE FINISH MASK'S RED-FIRST: a steep-flank surface where the exact per-point rule keeps a
 * point and the rounded-grid read of `cd5ec056` drops it.
 *
 * `cd5ec056` gave the mask a leftover grid read by ONE `Math.round` cell per point. On the
 * panther's 74–89° flanks the CL varies between samples, the rounded cell said "no leftover"
 * where the exact query said leftover, and the finish stopped running there (coverage
 * 73.17 → 49.09 %, #965's bisect). The ruling on #970: the exact per-point rule is the mask's
 * rule; this spec pins it. The rounded reader below is the PRE-FIX algorithm, kept here as the
 * red side of the comparison — it is not production code.
 */

import { describe, expect, it } from 'vitest';

import { maskCellsExact } from '@/engine/cnc/cam/model/finishMask';

/** The pre-fix read, reproduced: one rounded cell from a 0.5 mm grid. */
const roundedGridRead = (leftoverCell: (i: number, j: number) => boolean, x: number, y: number): boolean => {
  const i = Math.round(x / 0.5);
  const j = Math.round(y / 0.5);
  return leftoverCell(i, j);
};

describe('#970 the finish mask uses the exact per-point rule', () => {
  it('RED-FIRST: a point exactly between two samples keeps the leftover the rounded grid read drops', () => {
    // The steep flank: cell (0, 1) is leftover, cell (1, 1) is not — the CL falls across the rise.
    const leftoverCell = (i: number, j: number): boolean => i === 0 && j === 1;
    // The EXACT rule on that surface: the point (0.25, 0.75) lies in the leftover side (the exact
    // CL over the band). The mask keeps it.
    const exactLeftover = (x: number, y: number): boolean => x >= 0 && x < 0.5 && y >= 0.5 && y < 1.0;
    expect(maskCellsExact(exactLeftover, [], 0.25, 0.75)).toBe(true);
    // The pre-fix grid read at the half-cell tie (Math.round HALF UP) picks cell (1, 1) and
    // misses the leftover at cell (0, 1) — the mask returned false here.
    expect(roundedGridRead(leftoverCell, 0.25, 0.75)).toBe(false);
  });

  it('the ball footprint is part of the rule: a ring point over the leftover plants the centre', () => {
    const exactLeftover = (x: number, y: number): boolean => x >= 0 && x < 0.5 && y >= 0.5 && y < 1.0;
    const ring: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    // The centre (1.25, 0.75) is not leftover itself; its -x ring point (0.25, 0.75) is.
    expect(maskCellsExact(exactLeftover, ring, 1.25, 0.75)).toBe(true);
    // A point whose centre and ring are both clear is not planted.
    expect(maskCellsExact(exactLeftover, ring, 3.0, 3.0)).toBe(false);
  });

  it('every point INSIDE the leftover is planted — the rule cannot drop one', () => {
    // The exact rule's guarantee, by construction: the mask plants a point wherever the exact
    // per-point test says leftover, at every sample of a fine grid across the leftover surface.
    const exactLeftover = (x: number, y: number): boolean => x >= 0 && x < 2 && y >= 0 && y < 2;
    let planted = 0;
    for (let x = 0; x < 2; x += 0.05) {
      for (let y = 0; y < 2; y += 0.05) {
        expect(maskCellsExact(exactLeftover, [], x, y), `(${x.toFixed(2)}, ${y.toFixed(2)})`).toBe(true);
        planted++;
      }
    }
    expect(planted).toBe(40 * 40);
  });
});
