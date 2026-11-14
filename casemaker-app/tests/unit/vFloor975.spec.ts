/**
 * #975 — A NARROW POCKET GETS THE V BIT, CUT AS A FLOOR-CORRECT POCKET.
 *
 * The maintainer's ruling (2026-11-05, relayed by the review session): the picker plans the ideal
 * from every bit the app knows, then implements with the tools the shop owns — "never a refusal
 * where a tool in the set can do the job". The tray's digits are the case: 0.72–0.80 mm strokes,
 * 0.60 mm deep, which no flat or ball in the set enters. The owned 90° V cuts them as a
 * FLOOR-CORRECT POCKET — floor at the model's depth and the model's outline at that plane, walls
 * at the V's half-angle, land per side `depth · tan(half)` stated on the plan, never a failure.
 *
 * The standing V ruling behind it (the maintainer, 2026-10-17, #221): "a v carve should only be
 * concerned with making the area at the bottom correct (it will take more material off the sides
 * based on the slope and should be able to do the entire job without the bigger bit...)".
 *
 * These cases pin the picker's own behaviour; the tray's real-mesh acceptance is separate and
 * gated on its §8.9 cost line.
 */

import { describe, expect, it } from 'vitest';

import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import type { FeatureTree, PocketNode } from '@/engine/cnc/cam/model/features';
import { planPocketsForTree, type PlanPocketsResult } from '@/engine/cnc/cam/model/plan';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { tl } from './helpers/manifoldExec';
import { DEFAULT_RELEASE_TABS } from '@/engine/cnc/cam/model/plan';

const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
/** The tray's own T4: 3.175 mm 90° chamfer, 0.1 mm tip. */
const CHAMFER90: Tool = {
  ...flatEndMill(3.175, { number: 4, id: '122111013890', name: '3.175mm 90° chamfer', fluteLength: 30 }),
  shape: 'chamfer',
  typeText: 'V-Bit',
  tipDiameter: 0.1,
  angle: 90,
} as Tool;

/** A 40 × 20 plate with one narrow pocket: `strokeMm` wide, `depthMm` deep. */
function narrowPocketTree(strokeMm: number, depthMm: number): FeatureTree {
  const outline: [number, number][][] = [[[0, 0], [40, 0], [40, 20], [0, 20]]];
  const w = strokeMm;
  const pocketRect: [number, number][][] = [[[20, 10 - w / 2], [20 + 4, 10 - w / 2], [20 + 4, 10 + w / 2], [20, 10 + w / 2]]];
  const node: PocketNode = {
    id: 'digit', floorZ: -depthMm, mouthZ: 0, open: false, through: false,
    region: pocketRect, floors: [{ polygons: pocketRect, area: 4 * w }],
    islands: [], children: [], remainder: [], narrowest: w,
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: -depthMm },
    levels: [-depthMm],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline, area: 800, zTo: -depthMm, frees: true, shoulders: [] },
    pockets: [node],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 800, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

function plan(tree: FeatureTree, houseVs?: readonly Tool[]): PlanPocketsResult {
  return planPocketsForTree(tree, {
    tabs: DEFAULT_RELEASE_TABS, offset: makeClipperOffset(tl),
    houseFlats: [FLAT6],
    stepDownMm: 1.0,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: Z1.rapidEstimate,
    toolChangeSeconds: 12,
    spindleRpm: 12000,
    air: true,
    boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
    ...(houseVs === undefined ? {} : { houseVs }),
  });
}

describe('#975 — the V bit cuts a pocket no flat can enter, floor-correct', () => {
  it('baseline: with no V in the set the narrow pocket stays unreachable', () => {
    const result = plan(narrowPocketTree(0.8, 0.6));
    expect(result.ops.some((op) => op.region.id === 'digit')).toBe(false);
    expect(result.unreachable.some((u) => u.startsWith('digit'))).toBe(true);
  });

  it('with the 90° V in the set the pocket is cut: floor at the model depth, the V named on the program', () => {
    const result = plan(narrowPocketTree(0.8, 0.6), [CHAMFER90]);
    const op = result.ops.find((o) => o.region.id === 'digit' && o.kind === 'pocket');
    expect(op, `ops: ${result.ops.map((o) => `${o.kind}:${o.region.id}`).join(', ')}`).toBeDefined();
    // whoAt answers the V: the posted tool record is the V itself.
    expect(op!.outcome.ir.tool.id).toBe(CHAMFER90.id);
    // Floor-correct: every cutting move sits ON the model floor (one level, no stepped descent),
    // and the ring pitch is at most the tip radius, so the floor is flat, not a knife line.
    const cuts = op!.outcome.ir.operations.flatMap((o) => o.moves.filter((m) => m.kind === 'feed'));
    expect(cuts.length).toBeGreaterThan(0);
    for (const m of cuts) expect(m.z).toBeCloseTo(-0.6, 6);
    // The plan states the V's own geometry: land per side = depth x tan(half) = 0.6 mm at 90°.
    const note = result.notes.find((n) => n.startsWith('digit:'));
    expect(note, `notes: ${result.notes.join('; ')}`).toBeDefined();
    expect(note!).toContain('0.6');
    expect(note!).toMatch(/land/i);
    // And it is no longer an unreachable finding.
    expect(result.unreachable.some((u) => u.startsWith('digit'))).toBe(false);
  });

  it('a V whose tip is wider than the stroke does not fit — the pocket stays unreachable', () => {
    const wideTip: Tool = { ...CHAMFER90, tipDiameter: 1.2 } as Tool;
    const result = plan(narrowPocketTree(0.8, 0.6), [wideTip]);
    expect(result.unreachable.some((u) => u.startsWith('digit'))).toBe(true);
  });

  it('a V whose leg does not reach the depth does not fit — the pocket stays unreachable', () => {
    const shortLeg: Tool = { ...CHAMFER90, angle: 170 } as Tool;
    const result = plan(narrowPocketTree(0.8, 2.5), [shortLeg]);
    expect(result.unreachable.some((u) => u.startsWith('digit'))).toBe(true);
  });

  it('a flat still takes a pocket it covers — the V never outranks a covering flat', () => {
    const result = plan(narrowPocketTree(8, 0.6), [CHAMFER90]);
    const op = result.ops.find((o) => o.region.id === 'digit');
    expect(op).toBeDefined();
    expect(op!.outcome.ir.tool.id).not.toBe(CHAMFER90.id);
  });
});
