/**
 * #1219 (planner v3 A3) — THE POCKET'S STEP-OVER IS THE CUTTER'S FEED ROW'S OWN.
 *
 * The pocket planner used to space contour-parallel passes a fixed quarter of the diameter,
 * whatever row the cutter ran (Makera: 1.60 mm on the tray's wide recess; ours: 0.79 mm). The
 * helper below takes the row's value, capped at the radius; the planner-level test proves a wider
 * spacing makes a materially shorter pocket path.
 */
import { describe, expect, it } from 'vitest';

import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import type { FeatureTree, PocketNode } from '@/engine/cnc/cam/model/features';
import { planPocketsForTree, pocketStepOverMm, type PlanPocketsResult } from '@/engine/cnc/cam/model/plan';
import { Z1 } from '@/engine/cnc/machine';
import { cuttingDiameter, flatEndMill, type Tool } from '@/engine/cnc/tool';
import { tl } from './helpers/manifoldExec';

describe('#1219 pocketStepOverMm', () => {
  it('uses the row’s own value', () => {
    expect(pocketStepOverMm(6, 2.7)).toBeCloseTo(2.7, 9);
    expect(pocketStepOverMm(3.175, 1.42875)).toBeCloseTo(1.42875, 9);
  });

  it('never exceeds the radius', () => {
    expect(pocketStepOverMm(6, 5)).toBeCloseTo(3, 9);
  });

  it('falls back to a quarter of the diameter with no usable row value', () => {
    expect(pocketStepOverMm(6, null)).toBeCloseTo(1.5, 9);
    expect(pocketStepOverMm(6, undefined)).toBeCloseTo(1.5, 9);
    expect(pocketStepOverMm(6, 0)).toBeCloseTo(1.5, 9);
    expect(pocketStepOverMm(6, Number.NaN)).toBeCloseTo(1.5, 9);
    expect(pocketStepOverMm(6, -1)).toBeCloseTo(1.5, 9);
  });
});

// ── the planner-level test: a wider step-over makes a shorter pocket path ─────────────────────
const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });

/** #943's 40 × 20 plate with one 10 × 10 pocket 3 mm deep and 0.8 mm of skin — copied unchanged. */
function facingTree(skinMm: number): FeatureTree {
  const outline: [number, number][][] = [[[0, 0], [40, 0], [40, 20], [0, 20]]];
  const pocketRect: [number, number][][] = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  const partTop = -skinMm;
  const floorZ = partTop - 3;
  const node: PocketNode = {
    id: 'p', floorZ, mouthZ: partTop, open: false, through: false,
    region: pocketRect, floors: [{ polygons: pocketRect, area: 100 }],
    islands: [], children: [], remainder: [], narrowest: 10,
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop, partBottom: floorZ },
    levels: [floorZ],
    top: { z: partTop, floors: [], area: 0 },
    contour: { outline, area: 800, zTo: floorZ, frees: true, shoulders: [] },
    pockets: [node],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 800, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

function planWithStepOverShare(share: number): PlanPocketsResult {
  return planPocketsForTree(facingTree(0.8), {
    offset: makeClipperOffset(tl),
    houseFlats: [FLAT6],
    stepDownMm: 1.0,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: Z1.rapidEstimate,
    toolChangeSeconds: 12,
    spindleRpm: 12000,
    air: true,
    boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
    facing: 'on',
    paramsFor: (tool) => ({
      rpm: 12000,
      feed: 600,
      plungeFeed: 200,
      stepDown: 1,
      stepOver: (cuttingDiameter(tool) ?? 1) * share,
      peck: 0,
      air: true,
    }),
  });
}

/** The feed length of every pocket op's moves, summed over the pocket's own ops. */
function pocketFeedLength(result: PlanPocketsResult): number {
  const ops = result.ops.filter((o) => o.region.id === 'p');
  expect(ops.length, `ops: ${result.ops.map((o) => o.region.id).join(', ')}`).toBeGreaterThan(0);
  let total = 0;
  for (const op of ops) {
    for (const operation of op.outcome.ir.operations) {
      const moves = operation.moves;
      for (let i = 1; i < moves.length; i++) {
        const p = moves[i - 1]!;
        const q = moves[i]!;
        if (q.kind !== 'feed') continue;
        total += Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
      }
    }
  }
  return total;
}

describe('#1219 the planner runs the row’s step-over', () => {
  it('a wider step-over makes a shorter pocket path', () => {
    const narrow = pocketFeedLength(planWithStepOverShare(0.25));
    const wide = pocketFeedLength(planWithStepOverShare(0.45));
    expect(narrow).toBeGreaterThan(0);
    expect(wide).toBeGreaterThan(0);
    expect(wide).toBeLessThan(0.8 * narrow);
  });
});
