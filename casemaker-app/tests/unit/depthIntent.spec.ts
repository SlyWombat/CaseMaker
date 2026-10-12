// #170 — the two-state depth control's arithmetic, and the reading that turns a depth back into a
// colour (decision 20).
//
// Decision 20 says a two-colour blank has exactly TWO outcomes for a floor, so the control offers
// two states and a numeric override. These pin what each state means as a depth, what a depth means
// back as a colour, and the three places those answers could go wrong: a boundary within one step of
// the engraved face, a floor exactly ON the boundary, and — the review that closed the issue — a job
// carrying a margin LARGER than a printed layer, where a state that stepped by the layer alone wrote
// a depth the app's own checker then refused (#170 review).

import { describe, it, expect } from 'vitest';
import {
  depthForIntent,
  floorColour,
  jobSplit,
  type LabelSplit,
} from '@/engine/cnc/engrave/depthIntent';
import {
  boundsFor,
  checkBounds,
  recommendLabelDepth,
  splitDepthOf,
} from '@/engine/cnc/engrave/depthBounds';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

/** The pair the control is handed, written as the two numbers a test is moving. */
const at = (depth: number, step: number): LabelSplit => ({ depth, step });

describe('depthForIntent (#170)', () => {
  it('puts the floor one step on the state’s side of the split', () => {
    expect(depthForIntent('surface', at(1.2, 0.2))).toBeCloseTo(1.0, 9);
    expect(depthForIntent('reveal', at(1.2, 0.2))).toBeCloseTo(1.4, 9);
  });

  it('reads the step off the split, never a fixed number', () => {
    // The same blank sliced at a different layer height moves BOTH states — which is why the step
    // travels with the split instead of being a constant somewhere.
    expect(depthForIntent('reveal', at(1.2, 0.3))).toBeCloseTo(1.5, 9);
    expect(depthForIntent('reveal', at(1.2, 0.1))).toBeCloseTo(1.3, 9);
    expect(depthForIntent('surface', at(1.2, 0.3))).toBeCloseTo(0.9, 9);
  });

  it('never returns a depth below the top face: a split within one step has no top colour left', () => {
    // 0.1 mm down with a 0.2 step: there is no whole layer of top colour to stay in, and a negative
    // depth is not a depth. 0 is the honest answer, and the app's own findings say what is wrong
    // with a blank that thin — this module does not invent a number for it.
    expect(depthForIntent('surface', at(0.1, 0.2))).toBe(0);
    expect(depthForIntent('reveal', at(0.1, 0.2))).toBeCloseTo(0.3, 9);
  });

  it('writes the thousandth, not the binary tail of a grid sum', () => {
    // Not an exotic input: both operands are layer lines the grid builds by ADDING, so this is the
    // ordinary case. The default badge's boundary is `0.2 + 3 × 0.2` (0.8, as it happens) and its
    // `surface` floor is `0.8 − 0.2` = `0.6000000000000001` — the number the depth field would show
    // and the number the checker would judge against a plane it misses by a trillionth.
    expect(0.8 - 0.2).not.toBe(0.6);
    expect(depthForIntent('surface', at(0.8, 0.2))).toBe(0.6);
    expect(depthForIntent('reveal', at(0.8, 0.2))).toBe(1);
  });

  it('does not step AWAY from the bound for the sake of a tidy number', () => {
    // `3.6 + 0.2` is `3.8000000000000003` to a float. Quantised to the NEAREST thousandth that is
    // the 3.8 a person pressed for; rounded UP bare it would be 3.801 — a floor a thousandth deeper
    // than the state means, for a binary tail (#170 review). `deeper`'s tolerance swallows the tail
    // and leaves the true step alone.
    expect(depthForIntent('reveal', at(3.6, 0.2))).toBe(3.8);
    expect(depthForIntent('surface', at(3.6, 0.2))).toBe(3.4);
  });

  it('does NOT clamp the deep end — the ceiling is the job’s number, not this function’s', () => {
    // `thickness − minFloor` is a job field and is not an argument here. The row marks a depth past
    // it (`maxDepth`) and `depth-exceeds-stock` is the finding; a ceiling invented here would be a
    // second opinion about a stock this function was never shown.
    expect(depthForIntent('reveal', at(4.0, 0.2))).toBeCloseTo(4.2, 9);
  });
});

describe('floorColour (#170)', () => {
  it('is the top colour short of the split and the bottom one past it', () => {
    expect(floorColour(1.0, 1.2)).toBe('top');
    expect(floorColour(1.4, 1.2)).toBe('bottom');
  });

  it('reads a floor EXACTLY on the split as the bottom colour', () => {
    // Not a tie-break: the split is the plane where the top colour ENDS, so a cut stopping there
    // has removed every layer of top colour over its footprint. Both states write a whole step
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
    expect(jobSplit(job, 0.2)).toBeNull();
  });

  it('holds no boundary number of its own: the depth is the one the checker judges against', () => {
    // #345 spent an issue removing a second opinion about where the split lands. This module is not
    // allowed to reintroduce one — not even a "provisional" one — so the number it hands the control
    // is `splitDepthOf`'s verbatim, which is `colourBoundaryDepthFor`'s, which is what
    // `item-depth-bound` refuses against.
    const job = defaultEngraveJob();
    job.stock.thickness = 3.81;
    job.stock.print = { split: 2.54, layerHeight: 0.2, firstLayerHeight: 0.2 };
    expect(jobSplit(job, 0.2)!.depth).toBe(splitDepthOf(job));
  });

  it('reports the boundary where the LAYER GRID puts it, with the blank’s own layer height', () => {
    const job = defaultEngraveJob();
    job.stock.thickness = 3.81;
    // thickness − split = 1.27 nominal; on a 0.2 mm grid the boundary is the layer line NEAREST it,
    // which is 1.2 (0.07 away against 0.13 to 1.4) — the same number `item-depth-bound` judges
    // against, because both ask `colourBoundaryDepthFor` (#285, #345).
    job.stock.print = { split: 2.54, layerHeight: 0.2, firstLayerHeight: 0.2 };
    expect(jobSplit(job, 0.2)).toEqual({ depth: 1.2, step: 0.2 });
    // A margin TIGHTER than a layer changes nothing: the step is a layer, because a floor a layer
    // off the plane is already further off it than this job's margin asks for.
    expect(jobSplit(job, 0.1)!.step).toBe(0.2);
  });

  it('takes the MARGIN in force as the step when that is further than a layer (#170 review)', () => {
    // The badge route's dome: `recommendMargins` offers 0.331 on a 0.2 mm-layer blank, and
    // `checkBounds` then holds every floor to 0.331 whatever the grid says. Stepping by the layer
    // alone writes a `reveal` at `split + 0.2`, which is INSIDE that margin — a depth
    // `item-depth-bound` refuses and the worker drops from the cut (#170 review).
    const job = defaultEngraveJob();
    job.stock.thickness = 3.81;
    job.stock.print = { split: 2.54, layerHeight: 0.2, firstLayerHeight: 0.2 };
    expect(jobSplit(job, 0.331)).toEqual({ depth: 1.2, step: 0.331 });
  });

  it('uses the FIRST layer’s own height, like every other depth number on the blank', () => {
    // Decision 27: the first layer is its own size. A grid of `0.3` then `0.2`s puts the boundary
    // at a different line than a uniform 0.2 grid, and this must not be the only place that
    // forgets — `jobSplit` reads the same `splitDepthOf` the verifier does.
    const job = defaultEngraveJob();
    job.stock.thickness = 3.81;
    job.stock.print = { split: 2.54, layerHeight: 0.2, firstLayerHeight: 0.3 };
    const split = jobSplit(job, 0.2);
    expect(split).not.toBeNull();
    expect(split!.step).toBe(0.2);
    // The grid runs 0.3, 0.5, 0.7 … so the nearest line to the nominal 1.27 is 1.3, where a uniform
    // 0.2 grid puts it at 1.2. The boundary MOVES with the first layer's height, and this is one of
    // the places that has to know.
    expect(split!.depth).toBeCloseTo(1.3, 9);
  });
});

// #170 review — the write the control makes has to be one the CHECKER accepts, on the same blank and
// with the same margin, and it has to be the number the #362 row beside it prints. Both were true
// while the margin was the shipped default (one layer) and both broke the moment a job carried a
// margin of its own, which is the state a printed badge is in the moment "Use it" is pressed.
describe('the two-state control against the checker (#170 review)', () => {
  /** A 3.81 mm printed badge whose split lands 1.2 mm down, on the default vise. */
  function printedBadge(): ReturnType<typeof defaultEngraveJob> {
    const job = defaultEngraveJob();
    job.stock.thickness = 3.81;
    job.stock.print = { split: 2.54, layerHeight: 0.2, firstLayerHeight: 0.2 };
    return job;
  }
  /** The margin `recommendMargins` offers a domed blank: more than a layer, so the step changes. */
  const MARGIN = 0.331;

  it('writes a reveal the checker accepts, and the same number the #362 row states', () => {
    const job = printedBadge();
    const split = jobSplit(job, MARGIN)!;
    expect(split).toEqual({ depth: 1.2, step: MARGIN });

    const label = job.labels[0]!;
    const reveal = depthForIntent('reveal', split);
    const bounds = boundsFor(job, { ...label, depthIntent: 'reveal' }, { split: split.depth }, MARGIN);

    // One step past the plane, and the plane is at 1.2 — so 1.531, NOT the 1.4 a layer's step gives.
    expect(reveal).toBeCloseTo(1.531, 9);
    expect(checkBounds(reveal, bounds, MARGIN)).toBeNull();
    // The number the layer's step writes is the one the review filed: inside the margin, refused.
    expect(checkBounds(split.depth + 0.2, bounds, MARGIN)).not.toBeNull();

    // THE ROW BESIDE IT: the recommendation for a label that has stated nothing. A person pressing
    // "reveal" and a person reading "Recommended …" must be looking at the same floor.
    const row = recommendLabelDepth(
      job,
      { ...label, depthIntent: undefined },
      { voidLimit: null, boundaryMargin: MARGIN },
    )!;
    expect(row.depthIntent).toBe('reveal');
    expect(reveal).toBe(row.depth);
  });

  it('writes a surface the checker accepts, on the other side of the same plane', () => {
    const job = printedBadge();
    const split = jobSplit(job, MARGIN)!;
    const label = job.labels[0]!;
    const surface = depthForIntent('surface', split);
    const bounds = boundsFor(job, { ...label, depthIntent: 'surface' }, { split: split.depth }, MARGIN);

    expect(surface).toBeCloseTo(0.869, 9);
    expect(checkBounds(surface, bounds, MARGIN)).toBeNull();
    // The layer's step lands INSIDE the band around the plane, where neither bound can hold it: a
    // floor at 1.2 is the plane itself, which a `surface` is refused for and a `reveal` needs
    // 0.331 past.
    expect(checkBounds(split.depth, bounds, MARGIN)).not.toBeNull();
  });
});
