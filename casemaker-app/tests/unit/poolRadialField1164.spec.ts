// #1164 slice (a) — rule 5: a planning field coarser than the judged one carries the HIGHEST goal
// radius over its own footprint, so a coarse plan can only stand off, never cut in (#1155's 1 mm
// centre sample beside a 0.1 mm-judged shelf was the measured case).
import { describe, expect, it } from 'vitest';

import type { GoalRadialField } from '@/engine/cnc/rotary/radialField';
import { poolRadialField } from '@/engine/cnc/rotary/poolRadialField';

const R = 20;

function field(z: number[]): GoalRadialField {
  const nx = 10;
  const ny = 10 * 5; // a 10 × 50 fine map: a 5-cell block divides both axes
  const values = new Float32Array(nx * ny);
  const covered = new Uint8Array(nx * ny);
  for (let k = 0; k < values.length; k++) {
    const value = z[k % z.length]!;
    values[k] = value;
    covered[k] = value === 0 ? 0 : 1;
  }
  return {
    nx,
    ny,
    x0: 0,
    y0: 0,
    pitch: 0.1,
    radius: R,
    minRadius: R + Math.min(...z),
    maxRadius: R,
    z: values,
    covered,
    coveredCount: covered.reduce((n, c) => n + c, 0),
    resolutionNote: 'test',
  };
}

describe('#1164 the planning field pools the fine one', () => {
  it('a groove one fine cell wide does NOT survive pooling — the cell keeps the surface it stands beside', () => {
    // One fine cell of a 5-cell block is cut 3 mm down; the other four are the envelope. A plan on
    // this coarse field must regard the whole block as the envelope: the cutter stands off, which
    // is the conservative direction the rule wants.
    const fine = field([-3, 0, 0, 0, 0]);
    const coarse = poolRadialField(fine, 0.5);
    expect(coarse.pitch).toBe(0.5);
    expect(coarse.nx).toBe(2);
    expect(coarse.ny).toBe(10);
    for (let k = 0; k < coarse.z.length; k++) expect(coarse.z[k], `cell ${k}`).toBe(0);
    // The pooled minRadius is the envelope too, so the tip drop's reach is computed from what the
    // PLAN can actually see — never from a groove the coarse cell lost.
    expect(coarse.minRadius).toBe(R);
  });

  it('a groove as wide as the block pools to the groove, and minRadius is the pooled depth', () => {
    const fine = field([-3]);
    const coarse = poolRadialField(fine, 0.5);
    for (let k = 0; k < coarse.z.length; k++) expect(coarse.z[k]).toBe(-3);
    expect(coarse.minRadius).toBe(R - 3);
  });

  it('a block half groove, half envelope reads the envelope (max over the footprint)', () => {
    const fine = field([-3, -3, -3, 0, 0]);
    const coarse = poolRadialField(fine, 0.5);
    // Each block takes five consecutive fine cells cycling; blocks whose five include a 0 read 0.
    expect(Math.max(...coarse.z)).toBe(0);
    expect(Math.min(...coarse.z)).toBe(0);
  });

  it('an uncovered fine cell is the stock surface under the coarse cell', () => {
    const fine = field([0]);
    const fineWithOneCut = {
      ...fine,
      z: Float32Array.from(fine.z, (v, k) => (k === 0 ? -2 : v)),
      covered: Uint8Array.from(fine.covered, (c, k) => (k === 0 ? 1 : c)),
    };
    const coarse = poolRadialField(fineWithOneCut, 0.5);
    expect(coarse.z[0]).toBe(0); // the cut cell is pooled with four uncovered ones: the surface wins
    expect(coarse.covered[0]).toBe(1); // it is still a cell the plan must consider
  });

  it('refuses a pitch that is not a whole number of fine cells', () => {
    const fine = field([-1]);
    expect(() => poolRadialField(fine, 0.35)).toThrow(/not a whole number/);
  });
});
