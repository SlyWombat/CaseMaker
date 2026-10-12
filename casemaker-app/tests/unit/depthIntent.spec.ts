// #170 — the two-state depth control's arithmetic, and the reading that turns a depth back into a
// colour (decision 20).
//
// Decision 20 says a two-colour blank has exactly TWO outcomes for a floor, so the control offers
// two states and a numeric override. These pin what each state means as a depth, what a depth means
// back as a colour, and the two places those answers could go wrong: a boundary within one layer of
// the engraved face, and a floor exactly ON the boundary.

import { describe, it, expect } from 'vitest';
import { depthForIntent, floorColour, jobSplit } from '@/engine/cnc/engrave/depthIntent';
import { splitDepthOf } from '@/engine/cnc/engrave/depthBounds';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

describe('depthForIntent (#170)', () => {
  it('puts the floor one printed layer on the state’s side of the split', () => {
    expect(depthForIntent('surface', 1.2, 0.2)).toBeCloseTo(1.0, 9);
    expect(depthForIntent('reveal', 1.2, 0.2)).toBeCloseTo(1.4, 9);
  });

  it('reads the layer height as the step, never a fixed number', () => {
    // The same blank sliced at a different layer height moves BOTH states — which is why the layer
    // height travels with the split instead of being a constant somewhere.
    expect(depthForIntent('reveal', 1.2, 0.3)).toBeCloseTo(1.5, 9);
    expect(depthForIntent('reveal', 1.2, 0.1)).toBeCloseTo(1.3, 9);
    expect(depthForIntent('surface', 1.2, 0.3)).toBeCloseTo(0.9, 9);
  });

  it('never returns a depth below the top face: a split within one layer has no top colour left', () => {
    // 0.1 mm down on a 0.2 mm grid: there is no whole layer of top colour to stay in, and a negative
    // depth is not a depth. 0 is the honest answer, and the app's own findings say what is wrong
    // with a blank that thin — this module does not invent a number for it.
    expect(depthForIntent('surface', 0.1, 0.2)).toBe(0);
    expect(depthForIntent('reveal', 0.1, 0.2)).toBeCloseTo(0.3, 9);
  });

  it('writes the thousandth, not the binary tail of a grid sum', () => {
    // Not an exotic input: both operands are layer lines the grid builds by ADDING, so this is the
    // ordinary case. The default badge's boundary is `0.2 + 3 × 0.2` (0.8, as it happens) and its
    // `surface` floor is `0.8 − 0.2` = `0.6000000000000001` — the number the depth field would show
    // and the number the checker would judge against a plane it misses by a trillionth.
    expect(0.8 - 0.2).not.toBe(0.6);
    expect(depthForIntent('surface', 0.8, 0.2)).toBe(0.6);
    expect(depthForIntent('reveal', 0.8, 0.2)).toBe(1);
  });

  it('does NOT clamp the deep end — the ceiling is the job’s number, not this function’s', () => {
    // `thickness − minFloor` is a job field and is not an argument here. The row marks a depth past
    // it (`maxDepth`) and `depth-exceeds-stock` is the finding; a ceiling invented here would be a
    // second opinion about a stock this function was never shown.
    expect(depthForIntent('reveal', 3.6, 0.2)).toBeCloseTo(3.8, 9);
  });
});

describe('floorColour (#170)', () => {
  it('is the top colour short of the split and the bottom one past it', () => {
    expect(floorColour(1.0, 1.2)).toBe('top');
    expect(floorColour(1.4, 1.2)).toBe('bottom');
  });

  it('reads a floor EXACTLY on the split as the bottom colour', () => {
    // Not a tie-break: the split is the plane where the top colour ENDS, so a cut stopping there
    // has removed every layer of top colour over its footprint. Both states write a whole layer
    // clear of the plane, so the exact case is a typed override's — and it is the one the eye reads
    // as "through".
    expect(floorColour(1.2, 1.2)).toBe('bottom');
  });

  it('is null on a blank that states no split: there is no second colour to be in', () => {
    expect(floorColour(2, null)).toBeNull();
    expect(floorColour(0, null)).toBeNull();
  });
});

describe('jobSplit (#170)', () => {
  it('is null for a blank that states no print — the control is not offered, not zeroed', () => {
    const job = defaultEngraveJob();
    expect(job.stock.print).toBeUndefined();
    expect(jobSplit(job)).toBeNull();
  });

  it('holds no boundary number of its own: the depth is the one the checker judges against', () => {
    // #345 spent an issue removing a second opinion about where the split lands. This module is not
    // allowed to reintroduce one — not even a "provisional" one — so the number it hands the control
    // is `splitDepthOf`'s verbatim, which is `colourBoundaryDepthFor`'s, which is what
    // `item-depth-bound` refuses against.
    const job = defaultEngraveJob();
    job.stock.thickness = 3.81;
    job.stock.print = { split: 2.54, layerHeight: 0.2, firstLayerHeight: 0.2 };
    expect(jobSplit(job)!.depth).toBe(splitDepthOf(job));
  });

  it('reports the boundary where the LAYER GRID puts it, with the blank’s own layer height', () => {
    const job = defaultEngraveJob();
    job.stock.thickness = 3.81;
    // thickness − split = 1.27 nominal; on a 0.2 mm grid the boundary is the layer line NEAREST it,
    // which is 1.2 (0.07 away against 0.13 to 1.4) — the same number `item-depth-bound` judges
    // against, because both ask `colourBoundaryDepthFor` (#285, #345).
    job.stock.print = { split: 2.54, layerHeight: 0.2, firstLayerHeight: 0.2 };
    expect(jobSplit(job)).toEqual({ depth: 1.2, layerHeight: 0.2 });
  });

  it('uses the FIRST layer’s own height, like every other depth number on the blank', () => {
    // Decision 27: the first layer is its own size. A grid of `0.3` then `0.2`s puts the boundary
    // at a different line than a uniform 0.2 grid, and this must not be the only place that
    // forgets — `jobSplit` reads the same `splitDepthOf` the verifier does.
    const job = defaultEngraveJob();
    job.stock.thickness = 3.81;
    job.stock.print = { split: 2.54, layerHeight: 0.2, firstLayerHeight: 0.3 };
    const split = jobSplit(job);
    expect(split).not.toBeNull();
    expect(split!.layerHeight).toBe(0.2);
    // The grid runs 0.3, 0.5, 0.7 … so the nearest line to the nominal 1.27 is 1.3, where a uniform
    // 0.2 grid puts it at 1.2. The boundary MOVES with the first layer's height, and this is one of
    // the places that has to know.
    expect(split!.depth).toBeCloseTo(1.3, 9);
  });
});
