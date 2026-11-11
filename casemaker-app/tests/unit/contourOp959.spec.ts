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
    // The path is offset OUTSIDE the outline by the tool radius (3 mm) PLUS the op's own
    // ARC_CHORD_TOLERANCE_MM (0.005 mm) outward guard (E's measurement on fb9fdaae: Clipper's own
    // round-join chord approximation can land a real offset a few microns short of what was
    // asked, bounded by exactly that constant) — a corner at (20, 10) becomes (23.005, 13.005),
    // not (17, 7) or a bare (23, 13).
    const xs = op.moves.map((m) => m.x);
    expect(Math.max(...xs)).toBeCloseTo(23.005, 6);
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

  // E's measurement on fb9fdaae: over 3,083 contour feeds, the minimum clearance to the true
  // outline was 2.99704 mm against a stated 3 mm radius — a 0.00296 mm deficit at one segment,
  // Clipper's own round-join chord approximation, not this op's math. The op's own
  // ARC_CHORD_TOLERANCE_MM (0.005 mm) outward guard must cover that, whatever a REAL offset
  // function's own rounding does within its own stated bound — reproduced here with a fake that
  // shaves E's own measured deficit off every outward offset, the same direction it went
  // (advisor's review: an earlier version of this fixture shaved only 0.00003 mm, two orders of
  // magnitude short of the real deficit, and an earlier 0.001 mm guard would not have covered it).
  it('the outside path never sits closer than the cutter radius to the true outline, even when the offset itself rounds a few microns short', () => {
    const ROUNDING_DEFICIT_MM = 0.00296;
    const fakeRectOffsetShortByRounding: OffsetFn = (region, delta) =>
      fakeRectOffset(region, delta > 0 ? delta - ROUNDING_DEFICIT_MM : delta);
    const c = contourOf({ outline: rect(20, 10), area: 200, zTo: -6, frees: true, shoulders: [] });
    const out = contour({
      cutter: flat6, contour: c, region: region(),
      depthMm: 6, tabs: { count: 0, width: 0, height: 0 },
      offset: fakeRectOffsetShortByRounding, params, rapid,
    });
    const xs = out.ir.operations[0]!.moves.map((m) => m.x);
    expect(Math.max(...xs) - 20, 'clearance past the true outline, mm').toBeGreaterThanOrEqual(3);
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

// #1160 — badge-blank-top: a 0.81 mm part cut with the model plan's DEFAULT_RELEASE_TABS (1 mm
// tall) put the tab top at -(0.81 - 1) = +0.19 mm — ABOVE the stock top — and every candidate
// plan was refused by the post's own rule ("a cutting move at Z=0.19 is above the stock top yet
// below hopZ: a cut in the air"). A tab cannot be taller than the part it holds: the release
// contour's tab is clamped to the cut's own thickness, so its top is at most the stock top.
describe('#1160 the release tab cannot rise above the stock top', () => {
  const shallow = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });

  it('a 1 mm tab on a 0.81 mm part is clamped: no feed is posted above the stock top', () => {
    // #1206 — a 60 x 40 part, so the 6 mm tabs have the corner margin the mid-side rule asks for
    // (on the old 20 x 10 fixture, max(2 x 6, 10 %) = 12 mm a side leaves a 20 mm edge nothing).
    const c = contourOf({ outline: rect(60, 40), area: 2400, zTo: -0.81, frees: true, shoulders: [] });
    const out = contour({
      cutter: shallow, contour: c, region: region(),
      depthMm: 0.81, tabs: { count: 4, width: 6, height: 1 },
      offset: fakeRectOffset, params, rapid,
    });
    const moves = out.ir.operations[0]!.moves;
    const airCuts = moves.filter((m) => m.kind === 'feed' && m.z > 1e-9);
    expect(airCuts).toEqual([]);
    // The tab's top is the part's own top: the crossing feeds run AT the stock top, not above it.
    expect(moves.some((m) => m.kind === 'feed' && Math.abs(m.z) < 1e-9)).toBe(true);
    // The mask states the SAME clamped height the moves keep.
    expect(out.throughKerf).toBeUndefined(); // not a through cut here
  });

  it('a tab taller than a through cut’s stock is clamped to the stock thickness', () => {
    const c = contourOf({ outline: rect(20, 10), area: 200, zTo: -0.5, frees: true, shoulders: [] });
    const out = contour({
      cutter: shallow, contour: c, region: region(),
      depthMm: 0.8, thicknessMm: 0.5, through: true,
      tabs: { count: 4, width: 6, height: 1 },
      offset: fakeRectOffset, params, rapid,
    });
    const moves = out.ir.operations[0]!.moves;
    expect(moves.filter((m) => m.kind === 'feed' && m.z > 1e-9)).toEqual([]);
    expect(out.throughKerf!.tabHeight).toBeCloseTo(0.5, 9);
  });
});
