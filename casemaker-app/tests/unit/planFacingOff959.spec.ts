/**
 * #959 2026-11-05 ruling — FACING OFF BY DEFAULT, the skin to a `skin` pass. RED-FIRST.
 *
 * The rebuilt engine plans no facing stage unless the job asks: `facing` is an operator option,
 * absent → off. The gentle skin it used to take goes to a flat SURFACE-FOLLOWING pass (`skin`,
 * the op C6 names Makera's T1 by), capped at the ⌀6 row's 1.0 mm step-down — two passes on a
 * 1.2 mm skin, one on a 0.8 mm skin — and gated by the shared slope parameter
 * `FLAT_SURFACE_MAX_SLOPE_DEG` (default pending D's #960 picture; read as a parameter).
 *
 * The casts below are the red-first's own: today `facing` and `skin` do not exist, so the spec
 * must compile against the present API and fail at RUNTIME — which it does, on both counts.
 */

import { DEFAULT_RELEASE_TABS } from '@/engine/cnc/cam/model/plan';
import { describe, expect, it } from 'vitest';

import { planCurvedForTree, planPocketsForTree, type PlanPocketsOptions } from '../../src/engine/cnc/cam/model/plan';
import type { FeatureTree, PocketNode } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill } from '../../src/engine/cnc/tool';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { tl } from './helpers/manifoldExec';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const flat = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });

/** A 20×10 part under a skin: stock top 0, part top −skin, one CORNER pocket (so the land the
 * skin pass takes is real ground, not the pocket's own). */
function skinTree(skinMm: number): FeatureTree {
  const rect: [number, number][][] = [[[0, 0], [20, 0], [20, 10], [0, 10]]];
  const pocketRect: [number, number][][] = [[[0, 0], [6, 0], [6, 4], [0, 4]]];
  const partTop = -skinMm;
  const floorZ = partTop - 3;
  const node: PocketNode = {
    id: 'synthetic-1', floorZ, mouthZ: partTop, open: false, through: false,
    region: pocketRect, floors: [{ polygons: pocketRect, area: 24 }],
    islands: [], children: [], remainder: [], narrowest: 4,
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop, partBottom: floorZ },
    levels: [floorZ],
    top: { z: partTop, floors: [], area: 0 },
    contour: { outline: rect, area: 200, zTo: floorZ, frees: true, shoulders: [] },
    pockets: [node],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 200, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

function plan(tree: FeatureTree, extra: Record<string, unknown> = {}) {
  const opts = {
    tabs: DEFAULT_RELEASE_TABS,
    offset: makeClipperOffset(tl),
    houseFlats: [flat],
    stepDownMm: 1.0,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: RAPID,
    toolChangeSeconds: 91.4,
    spindleRpm: 12000,
    air: true,
    ...extra,
  } as unknown as PlanPocketsOptions;
  return planPocketsForTree(tree, opts);
}

/** The mesh the skin pass reads: a plane at the part top over the whole outline, margin-extended. */
function skinGeometry(skinMm: number): { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } {
  const MX0 = -10, MX1 = 30, MY0 = -10, MY1 = 20;
  const z = -skinMm;
  return {
    triangles: {
      positions: Float32Array.from([MX0, MY0, z, MX1, MY0, z, MX1, MY1, z, MX0, MY0, z, MX1, MY1, z, MX0, MY1, z]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: { min: [MX0, MY0, z], max: [MX1, MY1, z] },
    },
  };
}

function planSkin(tree: FeatureTree, skinMm: number, extra: Record<string, unknown> = {}) {
  const ball = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6', fluteLength: 30 }), shape: 'ball' as const, typeText: 'Ball Nose' };
  return planCurvedForTree(tree, {
    geometry: skinGeometry(skinMm),
    offset: makeClipperOffset(tl),
    flat,
    ball,
    stepDownMm: 1.0,
    bandMm: 0.3,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: RAPID,
    spindleRpm: 12000,
    air: true,
    safeZMm: 5,
    hopZMm: 1,
    edgeBreak: { legMm: 0 },
    toolNumberFor: (t: { number: number | null }) => t.number ?? 1,
    facing: 'off',
    flatSurfaceMaxSlopeDeg: 7.1,
    ...extra,
  } as Parameters<typeof planCurvedForTree>[1]);
}

describe('#959 ruling — facing off by default, the skin to a skin pass', () => {
  it('the default plan has NO facing stage', () => {
    const result = plan(skinTree(1.2));
    const facingOps = result.ops.filter((op) => op.region.id === 'facing');
    expect(facingOps.length, `ops: ${result.ops.map((o) => `${o.kind}:${o.region.id}`).join(', ')}`).toBe(0);
  });

  it('facing stays an operator option: facing on plans the stage', () => {
    const result = plan(skinTree(1.2), { facing: 'on' });
    const facingOps = result.ops.filter((op) => op.region.id === 'facing');
    expect(facingOps.length, 'facing on did not plan the facing stage').toBe(1);
  });

  it('the skin is taken by a skin pass, capped at the 1.0 mm step-down: two passes on a 1.2 skin', () => {
    const result = planSkin(skinTree(1.2), 1.2);
    const skinOps = result.ops.filter((op) => String(op.kind) === 'skin');
    expect(skinOps.length, `ops: ${result.ops.map((o) => `${o.kind}:${o.region.id}`).join(', ')}`).toBe(1);
    const feeds = skinOps[0]!.outcome.ir.operations.flatMap((o) => o.moves).filter((m) => m.kind === 'feed');
    const zs = new Set(feeds.map((m) => m.z.toFixed(3)));
    // Two passes over the skin: to -1.0, then to -1.2 (the part top).
    expect([...zs].sort((a, b) => Number(a) - Number(b))).toEqual(['-1.200', '-1.000']);
  });

  it('one pass on a 0.8 skin', () => {
    const result = planSkin(skinTree(0.8), 0.8);
    const skinOps = result.ops.filter((op) => String(op.kind) === 'skin');
    expect(skinOps.length).toBe(1);
    const feeds = skinOps[0]!.outcome.ir.operations.flatMap((o) => o.moves).filter((m) => m.kind === 'feed');
    const zs = new Set(feeds.map((m) => m.z.toFixed(3)));
    expect([...zs]).toEqual(['-0.800']);
  });
});
