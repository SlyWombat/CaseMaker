/**
 * #943's ruling on the facing/skin depth (the maintainer, relayed 2026-11-05), built on #959's
 * facing stage:
 *
 *  - the TOP is the HIGHEST probed point — the facing region's cut starts there, so the first
 *    pass is one row step below the highest material and no pass runs blind above the stock;
 *  - the TARGET is one step-down below the LOWEST probed point, clamped at the part top and
 *    stated when it clamps (the organizer's 0.8 mm skin is less than one 1.0 mm row step: one
 *    step deeper would cut the design's top face);
 *  - every pass is capped at the feed row's step-down; the count is the spread's consequence;
 *  - the plan states the touch count and the spread; with no probe data it uses the stated stock
 *    top and says so.
 *
 * The probe spread arrives as `stockProbes` on the plan's own input, in the plan's datum: the
 * registration writes Z0 at the lowest touch (#475's `Z0_REFERENCE`), so the lowest reading sits
 * at 0 and the highest at +spreadMm. The engine never reads the registration store (the
 * sim-worker import-graph rule); the caller hands the measurement in.
 */

import { describe, expect, it } from 'vitest';

import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import type { FeatureTree, PocketNode } from '@/engine/cnc/cam/model/features';
import { planModelCam, planPocketsForTree, type ModelPlanInput, type PlanPocketsResult } from '@/engine/cnc/cam/model/plan';
import type { StockProbes } from '@/engine/cnc/cam/model/types';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { buildRandomPart } from '../tools/randomParts';
import { tl } from './helpers/manifoldExec';

const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const RAPID = Z1.rapidEstimate;

/** A 40x20 plate with one 10x10 root pocket and `skinMm` of stock above the part top. */
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

function planFace(tree: FeatureTree, stockProbes?: StockProbes): PlanPocketsResult {
  return planPocketsForTree(tree, {
    offset: makeClipperOffset(tl),
    houseFlats: [FLAT6],
    stepDownMm: 1.0,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: RAPID,
    toolChangeSeconds: 12,
    spindleRpm: 12000,
    air: true,
    boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
    facing: 'on',
    ...(stockProbes === undefined ? {} : { stockProbes }),
  });
}

function facingOp(result: PlanPocketsResult): { depth: number; depthPasses: number; feedZs: number[] } {
  const op = result.ops.find((o) => o.region.id === 'facing');
  expect(op, `ops: ${result.ops.map((o) => o.region.id).join(', ')}`).toBeDefined();
  const operation = op!.outcome.ir.operations[0]!;
  const feedZs = op!.outcome.ir.operations
    .flatMap((o) => o.moves.filter((m) => m.kind === 'feed').map((m) => m.z));
  return { depth: operation.depth, depthPasses: operation.depthPasses, feedZs };
}

describe('#943 — facing depth from the probed stock', () => {
  it('the cut starts at the highest probed point and stops at the part top: the spread adds its pass', () => {
    // Organizer shape: 0.8 mm of skin, a 1.0 mm row step, a 0.3 mm spread.
    const probed = facingOp(planFace(facingTree(0.8), { count: 5, spreadMm: 0.3, source: 'probe' }));
    // Mouth at +0.3, floor at −0.8 → depth 1.1 — the part top still the floor (no gouge).
    expect(probed.depth).toBeCloseTo(1.1, 6);
    // Two passes where the unprobed plan takes one: the spread is a real pass, not air.
    expect(probed.depthPasses).toBe(2);
    expect(Math.min(...probed.feedZs)).toBeCloseTo(-0.8, 6);
    // The first cut level is one row step below the highest point (0.3 − 1.0).
    expect(Math.max(...probed.feedZs)).toBeCloseTo(-0.7, 6);
  });

  it('the part top clamps the target when one step below the lowest point would cut the design, and the plan says so', () => {
    const result = planFace(facingTree(0.8), { count: 5, spreadMm: 0.3, source: 'probe' });
    const clamp = result.notes.find((n) => n.startsWith('facing stops at the part top'));
    expect(clamp, `notes: ${result.notes.join('; ')}`).toBeDefined();
    expect(clamp!).toMatch(/less than one .*step/);
    expect(clamp!).toContain('would cut the design');
  });

  it('states the touch count and the spread on the plan', () => {
    const result = planFace(facingTree(1.2), { count: 7, spreadMm: 0.3, source: 'probe' });
    const note = result.notes.find((n) => n.startsWith('facing:'));
    expect(note, `notes: ${result.notes.join('; ')}`).toBeDefined();
    expect(note!).toContain('7');
    expect(note!).toContain('0.3');
  });

  it('a deeper skin takes the target as the part top, with the spread’s pass on top of it', () => {
    // Tray shape: 1.2 mm of skin, 1.0 mm step, 0.3 mm spread → total 1.5 → 2 passes either way.
    const probed = facingOp(planFace(facingTree(1.2), { count: 5, spreadMm: 0.3, source: 'probe' }));
    expect(probed.depth).toBeCloseTo(1.5, 6);
    expect(probed.depthPasses).toBe(2);
    expect(Math.min(...probed.feedZs)).toBeCloseTo(-1.2, 6);
    expect(Math.max(...probed.feedZs)).toBeCloseTo(-0.7, 6);
  });

  it('no probe data: the stated stock top is the top, and the plan says there was no measurement', () => {
    const result = planFace(facingTree(1.2));
    const probed = facingOp(result);
    expect(probed.depth).toBeCloseTo(1.2, 6);
    expect(probed.depthPasses).toBe(2);
    expect(Math.max(...probed.feedZs)).toBeCloseTo(-1.0, 6);
    const note = result.notes.find((n) => n.startsWith('facing:'));
    expect(note, `notes: ${result.notes.join('; ')}`).toBeDefined();
    expect(note!).toContain('no surface measurement');
  });

  it('planModelCam hands the measurement to the facing stage end to end', async () => {
    const part = buildRandomPart(3, 'rectilinear', tl);
    const skin = 1.2;
    const input: ModelPlanInput = {
      geometry: { triangles: part.mesh },
      facing: 'on',
      stockProbes: { count: 5, spreadMm: 0.3, source: 'probe' },
      setups: [{
        frame: { up: [0, 0, 1], stockTop: skin, stockBottom: skin - part.stock.thickness },
        underside: 'flatOnStockBottom',
      }],
      stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
      fixture: { mount: 'tape', envelope: null },
      cutters: { house: [FLAT6], catalogue: [] },
      tolerances: { finishMm: 0.01 },
      edgeBreak: { legMm: 0 },
    };
    const out = await planModelCam(input);
    const plan = out.perSetup[0]!;
    const facing = plan.ops.find((o) => o.region.id === 'facing');
    expect(facing, `ops: ${plan.ops.map((o) => o.region.id).join(', ')}`).toBeDefined();
    const operation = facing!.outcome.ir.operations[0]!;
    // The cut starts at the highest probed point, so the op's depth is the skin PLUS the spread;
    // the pass count itself follows the resolved feed row's step-down (asserted in the unit cases
    // above with a fixed 1.0 mm step).
    expect(operation.depth).toBeCloseTo(skin + 0.3, 6);
    expect(operation.depthPasses).toBeGreaterThanOrEqual(2);
    expect(plan.notes.some((n) => n.startsWith('facing:') && n.includes('5 surface touches') && n.includes('0.3'))).toBe(true);
  }, 120_000);
});
