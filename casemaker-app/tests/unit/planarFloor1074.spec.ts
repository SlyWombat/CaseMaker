/**
 * #1074 — A FLAT FLOOR INSIDE A CURVED REGION IS A POCKET FLOOR, NOT A BALL FINISH. When one
 * region is mostly a plane but ringed by rounded walls, finishKindFor judges the whole region and
 * gives the ball a scallop raster over the plane where a flat would take it in one pass. (The M1
 * tray's bottom job has no such region — its ceiling is already a 2.5D pocket and the ball's
 * region is the part's outer wall ring, which the plan's own `floor:detect` trace row states — so
 * the mechanism is pinned here, on a fixture.)
 *
 * The fixture: a flat floor at z=0 over [0,10]×[0,7] and a 45° wall up to z=3 over [7,10] — a
 * curved region (the flat share is 62 % of the 3D area, under the #960 90 % line) with a plane
 * inside it. RED at b32bf2a3c: the ball rasters the floor and no flat floor pass exists.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import { DEFAULT_FEATURE_TOLERANCES, type FeatureTree, type RemainderRegion } from '@/engine/cnc/cam/model/features';
import { planCurvedForTree, type PlanCurvedOptions } from '@/engine/cnc/cam/model/plan';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball2: Tool = { ...flatEndMill(2, { number: 2, id: 'ball-2', name: 'ball-2' }), shape: 'ball', typeText: 'Ball Nose' };

/** The floor at z=0 over y ∈ [0,7]; the 45° wall from (y=7, z=0) to (y=10, z=3). */
function recessMesh(): { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } {
  const positions = Float32Array.from([
    0, 0, 0, 10, 0, 0, 10, 7, 0,
    0, 0, 0, 10, 7, 0, 0, 7, 0,
    0, 7, 0, 10, 7, 0, 10, 10, 3,
    0, 7, 0, 10, 10, 3, 0, 10, 3,
  ]);
  return { positions, indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), triangleCount: 4, bbox: { min: [0, 0, 0], max: [10, 10, 3] } };
}

function tree(): FeatureTree {
  const outline: [number, number][][] = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  const region: RemainderRegion = {
    id: 'recess',
    footprint: outline,
    area: 100,
    zTop: 3,
    zBottom: 0,
    triangles: Uint32Array.from([0, 1, 2, 3]),
    slopeDeg: [0, 45],
    slopeMedianDeg: 0,
    in: 'top',
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -6, partTop: 3, partBottom: 0 },
    levels: [],
    top: { z: 0, floors: [], area: 100 },
    contour: { outline, area: 100, zTo: 0, frees: false, shoulders: [] },
    pockets: [],
    rims: [],
    remainder: [region],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 0, remainderArea: 100, tolerances: DEFAULT_FEATURE_TOLERANCES, slivers: [], notes: [] },
  };
}

function options(): PlanCurvedOptions {
  return {
    geometry: { triangles: recessMesh() },
    offset: makeClipperOffset(tl),
    flat: flat6,
    ball: ball2,
    stepDownMm: 1,
    bandMm: 0.3,
    finishScallopMm: 0.027,
    stepOverMm: 2,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: Z1.rapidEstimate,
    spindleRpm: 10_000,
    air: true,
    safeZMm: 12,
    hopZMm: 3,
    edgeBreak: { legMm: 0 },
    toolNumberFor: (t) => t.number ?? 1,
  };
}

type Move = { x: number; y: number; z: number; kind: string };

function feedPoints(outcome: { ir: { operations: { moves: Move[] }[] } }): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const op of outcome.ir.operations) for (const m of op.moves) if (m.kind === 'feed') out.push({ x: m.x, y: m.y });
  return out;
}

/** The floor's inner face: clear of the wall's foot band (the flat's disc climbs it within R=3 mm of y=7) and of the region's edges. */
const onFloor = (p: { x: number; y: number }): boolean => p.x > 1.5 && p.x < 8.5 && p.y > 1.5 && p.y < 3.5;

describe('#1074 a flat floor inside a curved region', () => {
  it('plans the floor as a flat pass and leaves the ball the walls', () => {
    const result = planCurvedForTree(tree(), options());
    const finishes = result.ops.filter((o) => o.kind === 'finish');
    const byCutter = finishes.map((o) => ({ cutter: o.outcome.cutter, onFloor: feedPoints(o.outcome).filter(onFloor).length, feeds: feedPoints(o.outcome).length }));
    const flatFinishes = finishes.filter((o) => o.outcome.cutter === 'flat-6');
    const ballFinishes = finishes.filter((o) => o.outcome.cutter === 'ball-2');
    // RED today: the ball carries the floor and no flat finish exists.
    expect(flatFinishes.length, `finish ops: ${JSON.stringify(byCutter)}`).toBeGreaterThanOrEqual(1);
    expect(byCutter.find((c) => c.cutter === 'flat-6')!.onFloor, 'the flat must cut the floor').toBeGreaterThan(0);
    for (const ball of ballFinishes) {
      expect(feedPoints(ball.outcome).filter(onFloor).length, `ball finishes: ${JSON.stringify(byCutter)}`).toBe(0);
    }
  }, 240_000);
});
