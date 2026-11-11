/**
 * #1052 — THE FINISH'S MOVE CAP, red-first.
 *
 * A finish op whose moves pass the cap refuses BY NAME (the rank drops the candidate and states
 * the number) instead of building an IR the heap cannot hold. The production cap is 5 M moves —
 * millions of moves to reach — so the op takes a test-injected cap here; the production number
 * itself is pinned beside it. The fixture is #960's sloped plane, the smallest surface the op
 * cuts on a real raster.
 */

import { describe, expect, it } from 'vitest';

import * as finishModule from '../../src/engine/cnc/cam/model/ops/finish';
import { clSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { FeatureSource, RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import type { Box2, RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const MESH_MARGIN_MM = 10;

function rampMesh(slope: number, length: number, half: number): FeatureSource {
  const x0 = -MESH_MARGIN_MM;
  const x1 = length + MESH_MARGIN_MM;
  const y0 = -half - MESH_MARGIN_MM;
  const y1 = half + MESH_MARGIN_MM;
  const z0 = slope * x0;
  const z1 = slope * x1;
  return {
    triangles: {
      positions: Float32Array.from([
        x0, y0, z0, x1, y0, z1, x1, y1, z1,
        x0, y0, z0, x1, y1, z1, x0, y1, z0,
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: { min: [x0, y0, Math.min(z0, z1)], max: [x1, y1, Math.max(z0, z1)] },
    },
  };
}

const SLOPE = -0.2;
const LENGTH = 50;
const HALF = 10;
const PAD = 0.5;

function rectRegion(zTop: number, zBottom: number): { region: RemainderRegion; regionRef: RegionRef } {
  const footprint: [number, number][][] = [[[PAD, -HALF + PAD], [LENGTH - PAD, -HALF + PAD], [LENGTH - PAD, HALF - PAD], [PAD, HALF - PAD]]];
  const region: RemainderRegion = {
    id: 'scoop',
    footprint,
    area: (LENGTH - 2 * PAD) * (2 * HALF - 2 * PAD),
    zTop,
    zBottom,
    triangles: new Uint32Array(),
    slopeDeg: [0, (Math.atan(Math.abs(SLOPE)) * 180) / Math.PI],
    slopeMedianDeg: (Math.atan(Math.abs(SLOPE)) * 180) / Math.PI,
    in: 'top',
  };
  const bounds: Box2 = { min: [PAD, -HALF + PAD], max: [LENGTH - PAD, HALF - PAD] };
  const regionRef: RegionRef = { id: 'scoop', kind: 'curved', bounds, topZ: zTop, bottomZ: zBottom, obstacles: [], regionClearanceZ: 5 };
  return { region, regionRef };
}

const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const ball6: Tool = { ...flatEndMill(6, { number: 1, id: 'ball-6', name: 'ball-6' }), shape: 'ball' };

const geometry = rampMesh(SLOPE, LENGTH, HALF);
const { region, regionRef } = rectRegion(0, -10);

function run(moveCap: number) {
  return finishModule.finish({
    cutter: ball6, region, regionRef, clSurface: clSurface(geometry, region, ball6, 3), kind: 'ball-scallop',
    scallopMm: 0.1, stepDownMm: 2, feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    safeZMm: 10, hopZMm: 3, axisPrecision: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid, moveCap,
  });
}

describe('#1052 the finish move cap', () => {
  it('states the production cap', () => {
    expect(finishModule.FINISH_MOVE_CAP).toBe(5_000_000);
  });

  it('refuses a finish past the cap by name, with its number', () => {
    // Red-first: before the guard this run simply built (and returned) the op.
    const TooMany = (finishModule as { PlanFinishTooManyMoves?: new (...args: never[]) => Error }).PlanFinishTooManyMoves;
    expect(TooMany).toBeTypeOf('function');
    const smallCap = 1_000;
    let thrown: unknown = null;
    try {
      run(smallCap);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TooMany!);
    const err = thrown as InstanceType<NonNullable<typeof TooMany>> & { moves: number; region: string; cap: number; message: string };
    expect(err.moves).toBeGreaterThan(smallCap);
    expect(err.region).toBe('scoop');
    expect(err.cap).toBe(smallCap);
    // The pre-build estimate is the gate; a count that only crosses during the build raises the
    // same class with "passed". Either way the number and the cap are in the sentence.
    expect(err.message).toMatch(/would build about|passed/);
    expect(err.message).toContain('the cap is 1,000 per op');
  });

  it('cuts the same fixture under a cap it does not reach', () => {
    const out = run(10_000_000);
    const posted = out.ir.operations[0]!.moves.length;
    // The fixture genuinely passes the small cap above — the refusal is not a vacuous pass.
    expect(posted).toBeGreaterThan(1_000);
  });

  it('cuts each cell once — a row point is not repeated level by level', () => {
    // Red-first: the old loop re-rastered the whole span at every level, so every row's XY
    // appeared at every level's z (5 levels on this fixture). A cell's band is the level whose
    // pass first reaches its CL; later levels must not cut it again.
    const out = run(10_000_000);
    const byXY = new Map<string, number>();
    for (const op of out.ir.operations) {
      for (const m of op.moves) {
        if (m.kind !== 'feed') continue;
        const key = `${m.x.toFixed(4)},${m.y.toFixed(4)}`;
        byXY.set(key, (byXY.get(key) ?? 0) + 1);
      }
    }
    expect(byXY.size).toBeGreaterThan(500);
    const repeated = [...byXY.values()].filter((n) => n > 1).length;
    // joins may legitimately revisit a point; the cutting rows must not
    expect(repeated / byXY.size).toBeLessThan(0.05);
  });
});
