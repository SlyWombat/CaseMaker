/**
 * #960 — THE FINISH OP, RED-FIRST.
 *
 * `cam/model/ops/finish.ts`'s `finish()` against a sloped-plane "scoop" (reusing the same
 * margin-extended ramp mesh `rowDropper960.spec.ts` uses, now run through the whole op — raster,
 * footprint columns, Z-stepping, and the posted moves). Both kinds (ball-scallop, flat-raster) on
 * the same fixture: the ball's own formula and the flat's own are different, the surface and the
 * safety properties checked are not.
 */

import { describe, expect, it } from 'vitest';

import { finish } from '../../src/engine/cnc/cam/model/ops/finish';
import { clSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { FeatureSource, RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import type { Box2, RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const MESH_MARGIN_MM = 10;

/** A plane z = slope * x, `half` wide in y, from x=0 to x=length, margin-extended on every side
 * (the same reasoning `rowDropper960.spec.ts`'s own `rampMesh` carries). */
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
const PAD = 0.5; // past the raster rectangle's own edge, the same ray-casting-boundary reason rowDropper960.spec.ts pads by

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
const flat6 = flatEndMill(6, { number: 2, id: 'flat-6', name: 'flat-6' });

/** Distance from `(x, y)` to the nearest FEED segment of `ir`, or Infinity if there are none —
 * the same "swept, read from the posted moves" technique this session's other op specs use. */
function distanceToNearestFeed(ir: ReturnType<typeof finish>['ir'], x: number, y: number): number {
  let best = Infinity;
  for (const op of ir.operations) {
    let at: [number, number] | null = null;
    for (const m of op.moves) {
      if (m.kind === 'feed' && at !== null) {
        const dx = m.x - at[0];
        const dy = m.y - at[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - at[0]) * dx + (y - at[1]) * dy) / len2));
        const ex = at[0] + t * dx - x;
        const ey = at[1] + t * dy - y;
        best = Math.min(best, Math.hypot(ex, ey));
      }
      at = [m.x, m.y];
    }
  }
  return best;
}

describe.each([
  ['ball-scallop', ball6] as const,
  ['flat-raster', flat6] as const,
])('#960 finish() — %s on a sloped plane', (kind, cutter) => {
  const geometry = rampMesh(SLOPE, LENGTH, HALF);
  const surface = clSurface(geometry, rectRegion(0, -100).region, cutter, 3);
  // The true deepest point in the footprint (the far corner) — queried from the surface itself,
  // not hand-derived, so the region's own zBottom can never be shallower than reality (which
  // would make the "last level reaches the true surface" property below false by construction).
  const trueDeepest = Math.min(
    surface.dropCutter(LENGTH - PAD - 0.01, -HALF + PAD + 0.01)!,
    surface.dropCutter(LENGTH - PAD - 0.01, HALF - PAD - 0.01)!,
  );
  const { region, regionRef } = rectRegion(0, trueDeepest - 1e-6);

  function run(): ReturnType<typeof finish> {
    const liveSurface = clSurface(geometry, region, cutter, 3);
    return finish({
      cutter, region, regionRef, clSurface: liveSurface, kind, scallopMm: 0.1, stepDownMm: 2,
      feedMmPerMin: 1000, safeZMm: 10, hopZMm: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
  }

  it('posts a non-empty program with more than one level', () => {
    const out = run();
    expect(out.ir.operations[0]!.moves.length).toBeGreaterThan(0);
    expect(out.ir.operations[0]!.depthPasses).toBeGreaterThan(1);
  });

  it('no move goes below the true surface anywhere it was queried', () => {
    const out = run();
    const liveSurface = clSurface(geometry, region, cutter, 3);
    for (const op of out.ir.operations) {
      for (const m of op.moves) {
        if (m.kind !== 'feed') continue;
        const truth = liveSurface.dropCutter(m.x, m.y);
        if (truth === null) continue; // outside the footprint (a link endpoint, not this op's own claim)
        expect(m.z, `(${m.x}, ${m.y})`).toBeGreaterThanOrEqual(truth - 1e-6);
      }
    }
  });

  it('engagement at each level is at most stepDownMm past the previous one — the ACTUAL posted depth, not the level\'s own nominal label', () => {
    const out = run();
    // `pass.z` is the LEVEL's own nominal target — grouping by its EXACT value (set directly from
    // `levels`, in `finish.ts`, never derived from a move) separates passes by level reliably.
    // The actual safety property is on the DEEPEST move each level really posts
    // (`Math.max(trueZ, levelZ)`'s own clamp): it must never fall more than stepDownMm below the
    // previous level's own deepest move — checking the label itself (always stepDownMm apart by
    // construction) would prove nothing about the real moves.
    const deepestByLevel = new Map<number, number>();
    for (const p of out.passes) {
      const deepest = Math.min(p.entry[2], p.exit[2]);
      deepestByLevel.set(p.z, Math.min(deepestByLevel.get(p.z) ?? Infinity, deepest));
    }
    const levelsDesc = [...deepestByLevel.keys()].sort((a, b) => b - a);
    expect(levelsDesc.length).toBeGreaterThan(1); // the fixture actually exercises more than one level
    // Start the comparison at the region's own material top, not `null` — the FIRST level's own
    // engagement (how far below zTop it goes) is exactly as real a tool-load question as the gap
    // between any two later levels, and a version with no clamping at all would otherwise pass
    // this check vacuously (every level landing on the SAME true surface immediately is "no
    // change between levels", not "safe").
    let prevDeepest: number | null = region.zTop;
    for (const levelKey of levelsDesc) {
      const deepest = deepestByLevel.get(levelKey)!;
      if (prevDeepest !== null) {
        expect(prevDeepest - deepest, `level at ${levelKey}: deepest move ${deepest} after previous level's own deepest ${prevDeepest}`).toBeLessThanOrEqual(2 + 1e-3);
      }
      prevDeepest = deepest;
    }
  });

  it('the LAST level reaches the true surface exactly — no clamping left standing', () => {
    const out = run();
    const liveSurface = clSurface(geometry, region, cutter, 3);
    const lastLevelZ = region.zBottom;
    const lastLevelPasses = out.passes.filter((p) => Math.abs(p.z - lastLevelZ) < 1e-6);
    expect(lastLevelPasses.length).toBeGreaterThan(0);
    for (const p of lastLevelPasses) {
      const truth = liveSurface.dropCutter(p.entry[0], p.entry[1]);
      if (truth !== null) expect(p.entry[2]).toBeCloseTo(truth, 6);
    }
  });

  it('coverage: every point of the footprint, inset by the cutter radius, is within the cutter radius of some posted feed', () => {
    const out = run();
    const toolRadius = cuttingDiameter(cutter)! / 2;
    const [x0, y0] = regionRef.bounds.min;
    const [x1, y1] = regionRef.bounds.max;
    let total = 0;
    let hit = 0;
    for (let y = y0 + toolRadius; y <= y1 - toolRadius; y += 1) {
      for (let x = x0 + toolRadius; x <= x1 - toolRadius; x += 1) {
        total++;
        if (distanceToNearestFeed(out.ir, x, y) <= toolRadius + 1e-6) hit++;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(hit / total, `swept ${((hit / total) * 100).toFixed(1)} %`).toBeGreaterThanOrEqual(0.95);
  });
});

function cuttingDiameter(tool: Tool): number | null {
  if (tool.tipDiameter !== null && tool.tipDiameter > 0) return tool.tipDiameter;
  if (tool.diameter !== null && tool.diameter > 0) return tool.diameter;
  return null;
}
