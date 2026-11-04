/**
 * #959 — THE POCKET OP, RED-FIRST.
 *
 * `cam/model/ops/pocket.ts` wraps the EXISTING `pocketLoops` (`cam/pocket.ts`) with Z-level
 * stepping and ring→move conversion. No Manifold/Clipper2 here: the offset is the same trivial
 * axis-aligned-rectangle fake `camPocket.spec.ts` uses, so this spec is a pure-geometry check of
 * the level stepping and move shape, not a second test of `pocketLoops` itself.
 */

import { describe, expect, it } from 'vitest';

import { pocket } from '../../src/engine/cnc/cam/model/ops/pocket';
import type { PocketNode } from '../../src/engine/cnc/cam/model/features';
import type { RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Tool } from '../../src/engine/cnc/tool';

function rect(w: number, h: number): Polygons {
  return [[[0, 0], [w, 0], [w, h], [0, h]]];
}

// Identical to camPocket.spec.ts's own fake: a rectangle shrinks by |delta| on every side.
function fakeRectOffset(region: Polygons, delta: number): Polygons {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of region) for (const [x, y] of c) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const s = Math.abs(delta);
  const w = maxX - minX - 2 * s;
  const h = maxY - minY - 2 * s;
  if (w <= 0 || h <= 0) return [];
  return [[[minX + s, minY + s], [maxX - s, minY + s], [maxX - s, maxY - s], [minX + s, maxY - s]]];
}

const flat6: Tool = {
  number: 1, id: 'flat-6', name: 'flat-6', typeText: 'flat', shape: 'flat',
  handleDiameter: 6, tipDiameter: null, diameter: 6, cornerRadius: null,
  angle: null, halfAngle: null, fluteLength: 20, shoulderLength: null,
  stickout: null, centreCutting: true,
};

const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };

function node(floorZ: number, mouthZ: number): PocketNode {
  return {
    id: 'p1', floorZ, mouthZ, open: false,
    region: rect(20, 10), floors: [], islands: [], children: [], remainder: [], narrowest: 10, through: false,
  };
}

function region(): RegionRef {
  return { id: 'p1', kind: 'pocket', bounds: { min: [0, 0], max: [20, 10] }, topZ: 0, bottomZ: -6, obstacles: [], regionClearanceZ: 5 };
}

describe('#959 pocket()', () => {
  it('steps the depth in stepDownMm increments, the last pass shorter not longer', () => {
    const out = pocket({
      cutter: flat6, node: node(-6, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    const op = out.ir.operations[0]!;
    expect(op.depthPasses).toBe(3); // ceil(6 / 2.5) = 3: -2.5, -5.0, -6.0
    expect(op.passStepMm).toBe(2.5);
    const zs = [...new Set(out.cleared!.map((c) => c.z))];
    expect(zs).toEqual([-2.5, -5, -6]);
  });

  it('every move is at the pocket floor or above, and the deepest level reaches exactly floorZ', () => {
    const out = pocket({
      cutter: flat6, node: node(-6, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    const moves = out.ir.operations[0]!.moves;
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect(m.z).toBeLessThanOrEqual(10);
    const deepest = Math.min(...moves.map((m) => m.z));
    expect(deepest).toBeCloseTo(-6, 9);
  });

  it('a single pass when the pocket is shallower than one step-down', () => {
    const out = pocket({
      cutter: flat6, node: node(-1, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    expect(out.ir.operations[0]!.depthPasses).toBe(1);
    expect(out.cleared!.map((c) => c.z)).toEqual([-1]);
  });

  it('reports the cutter key and a positive cycle estimate', () => {
    const out = pocket({
      cutter: flat6, node: node(-6, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    expect(out.cutter).toBe('flat-6');
    expect(out.ir.operations[0]!.estimatedSeconds).toBeGreaterThan(0);
    expect(out.passes.length).toBeGreaterThan(0);
    for (const p of out.passes) {
      expect(p.entry).toEqual(p.exit); // this op's rings close back to their own start
    }
  });

  it('refuses a cutter with no stated cutting diameter', () => {
    const noDiameter: Tool = { ...flat6, diameter: null, tipDiameter: null };
    expect(() =>
      pocket({
        cutter: noDiameter, node: node(-6, 0), region: region(),
        stepOverMm: 1.2, stepDownMm: 2.5,
        feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
        offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
        toolNumber: 1, spindleRpm: 12000, air: true, rapid,
      }),
    ).toThrow(/no cutting diameter/);
  });
});
