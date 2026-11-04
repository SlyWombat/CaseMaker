/**
 * #959 — THE CONTOUR OP, RED-FIRST.
 *
 * `cam/model/ops/contour.ts` wraps the EXISTING `generateProfile` (`cam/profile.ts`) unchanged for
 * the moves/step-downs/tabs themselves — no second geometry kernel, the same trivial
 * rectangle-offset fake `camPocket.spec.ts`/`pocketOp959.spec.ts` already use.
 */

import { describe, expect, it } from 'vitest';

import { contour } from '../../src/engine/cnc/cam/model/ops/contour';
import type { FeatureTree } from '../../src/engine/cnc/cam/model/features';
import type { RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { Polygons, OffsetFn } from '../../src/engine/cnc/cam/pocket';
import type { CutParams } from '../../src/engine/cnc/feeds';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { flatEndMill } from '../../src/engine/cnc/tool';

function rect(w: number, h: number): Polygons {
  return [[[0, 0], [w, 0], [w, h], [0, h]]];
}

// Identical to camPocket.spec.ts's own fake: a rectangle shrinks by |delta| (or grows, for a
// positive delta — `profilePath`'s 'outside' path needs the OUTWARD case too) on every side.
const fakeRectOffset: OffsetFn = (region, delta) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of region) for (const [x, y] of c) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const w = maxX - minX - 2 * delta;
  const h = maxY - minY - 2 * delta;
  if (w <= 0 || h <= 0) return [];
  return [[[minX - delta, minY - delta], [maxX + delta, minY - delta], [maxX + delta, maxY + delta], [minX - delta, maxY + delta]]];
};

const flat6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });

const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };

const params: CutParams = { rpm: 12000, feed: 1000, plungeFeed: 300, stepDown: 2.5, stepOver: 3, peck: 0, air: true };

function contourOf(tree: FeatureTree['contour']): FeatureTree['contour'] {
  return tree;
}

function region(): RegionRef {
  return { id: 'contour', kind: 'contour', bounds: { min: [0, 0], max: [20, 10] }, topZ: 0, bottomZ: -6, obstacles: [], regionClearanceZ: 5 };
}

describe('#959 contour()', () => {
  it('cuts the outline outside, one tool-radius further out, through the full depth in step-downs', () => {
    const c = contourOf({ outline: rect(20, 10), area: 200, zTo: -6, frees: true, shoulders: [] });
    const out = contour({
      cutter: flat6, contour: c, region: region(),
      depthMm: 6, tabs: { count: 0, width: 0, height: 0 },
      offset: fakeRectOffset, params, rapid,
    });
    const op = out.ir.operations[0]!;
    expect(op.depthPasses).toBe(3); // ceil(6 / 2.5) = 3
    expect(op.passStepMm).toBe(2.5);
    expect(op.moves.length).toBeGreaterThan(0);
    // The path is offset OUTSIDE the outline by the tool radius (3 mm): a corner at (20, 10)
    // becomes (23, 13), not (17, 7).
    const xs = op.moves.map((m) => m.x);
    expect(Math.max(...xs)).toBeCloseTo(23, 6);
    const deepest = Math.min(...op.moves.map((m) => m.z));
    expect(deepest).toBeCloseTo(-6, 9);
  });

  it('a zero-tab cut frees the part with no tab spans', () => {
    const c = contourOf({ outline: rect(20, 10), area: 200, zTo: -6, frees: true, shoulders: [] });
    const out = contour({
      cutter: flat6, contour: c, region: region(),
      depthMm: 6, tabs: { count: 0, width: 0, height: 0 },
      offset: fakeRectOffset, params, rapid,
    });
    expect(out.passes.length).toBeGreaterThan(0);
    expect(out.cutter).toBe('flat-6');
  });

  it('refuses a cutter with no stated cutting diameter', () => {
    const noDiameter = { ...flat6, diameter: null, tipDiameter: null };
    const c = contourOf({ outline: rect(20, 10), area: 200, zTo: -6, frees: true, shoulders: [] });
    expect(() =>
      contour({
        cutter: noDiameter, contour: c, region: region(),
        depthMm: 6, tabs: { count: 0, width: 0, height: 0 },
        offset: fakeRectOffset, params, rapid,
      }),
    ).toThrow(/no cutting diameter/);
  });
});
