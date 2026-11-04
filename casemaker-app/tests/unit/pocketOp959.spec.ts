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

  // E's run on 52590f76: 67.7 rapids/1,000 feed lines against Makera's 5.9 — one retract per ring.
  it('rings of the same level are joined by a feed, not a retract — one plunge per level, not per ring', () => {
    // A 20x10 rect with a 6mm flat and 1.2mm step-over leaves room for a second offset ring
    // before the fake offset collapses it (step 0 at -3: 14x4; step 1 at -4.2: 11.6x1.6; step 2
    // at -5.4: height goes negative, so pocketLoops stops there) — two rings, one level.
    const out = pocket({
      cutter: flat6, node: node(-2.5, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    expect(out.passes.length).toBeGreaterThanOrEqual(2);
    const moves = out.ir.operations[0]!.moves;
    const rapids = moves.filter((m) => m.kind === 'rapid');
    expect(rapids).toHaveLength(1); // one level, so exactly one rapid-to-hop, not one per ring
    expect(rapids[0]!.z).toBe(3);
    // The move right after the first ring closes is a FEED into the next ring, not a rapid.
    // Layout: rapid(0), plunge(1), ring 1's own 4 points as feeds (2..5) — 6 moves for a
    // 4-vertex rectangle ring — then index 6 is the connecting move into ring 2.
    const firstRapidIndex = moves.indexOf(rapids[0]!);
    const afterFirstRing = moves[firstRapidIndex + 6];
    expect(afterFirstRing?.kind).toBe('feed');
  });

  it('cleared grows conservatively as rings are traced, never claiming the whole region after only the outer ring', () => {
    // A 30x30 region (wide in both dimensions, unlike the 20x10 fixture above) so the ⌀6 tool's
    // first-ring sweep (2 x toolRadius = 6 mm in from every edge) leaves a real uncut interior —
    // 20x10 is too narrow for this assertion: a 6 mm sweep from both long edges already meets in
    // the middle of its 10 mm height, so "fully cleared after ring 1" would be the CORRECT
    // conservative answer there, not a bug.
    const wide: PocketNode = { ...node(-2.5, 0), region: rect(30, 30) };
    const wideRef: RegionRef = { ...region(), bounds: { min: [0, 0], max: [30, 30] } };
    const out = pocket({
      cutter: flat6, node: wide, region: wideRef,
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    expect(out.passes.length).toBeGreaterThanOrEqual(2);
    const areaOf = (polys: readonly [number, number][][]): number => {
      // Shoelace, outer minus holes — the same sign convention pocket.ts documents (CCW +, CW -).
      let a = 0;
      for (const ring of polys) {
        let ringArea = 0;
        for (let i = 0; i < ring.length; i++) {
          const [x0, y0] = ring[i]!;
          const [x1, y1] = ring[(i + 1) % ring.length]!;
          ringArea += x0 * y1 - x1 * y0;
        }
        a += ringArea / 2;
      }
      return Math.abs(a);
    };
    const firstCleared = areaOf(out.passes[0]!.cleared.boundary);
    const lastCleared = areaOf(out.passes[out.passes.length - 1]!.cleared.boundary);
    const wholeRegion = areaOf(rect(30, 30));
    expect(firstCleared).toBeLessThan(wholeRegion - 1e-6); // NOT the whole region after ring 1
    expect(lastCleared).toBeGreaterThanOrEqual(firstCleared); // grows (or stays, never shrinks)
  });
});
