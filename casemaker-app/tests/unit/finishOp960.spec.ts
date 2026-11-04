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
import { heightAt, profileOf } from '../../src/engine/cnc/cam/model/dropcutter';
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
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 }, safeZMm: 10, hopZMm: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid,
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

  // The same bug 9e976f0b fixed in `ops/pocket.ts`: a row's own first feed (the descent from the
  // hop height into material) must be at the plunge feed, never the ordinary cutting feed — every
  // OTHER (lateral) feed runs at the cutting feed instead.
  it('a row\'s own first feed is a plunge — every descending feed runs at the plunge rate, never the cutting rate', () => {
    const out = run();
    let descents = 0;
    for (const op of out.ir.operations) {
      let prev: { x: number; y: number; z: number } | null = null;
      for (const m of op.moves) {
        if (m.kind === 'feed' && prev !== null && m.z < prev.z - 1e-9) {
          descents++;
          expect(m.f, `a descending feed ran at ${m.f} mm/min, not the 300 mm/min plunge rate`).toBe(300);
        }
        prev = { x: m.x, y: m.y, z: m.z };
      }
    }
    expect(descents).toBeGreaterThan(0); // the fixture actually exercises a plunge
  });

  it('retracts between rows go to the region\'s own clearance plane, not a bare hop height', () => {
    const out = run();
    const rapids = out.ir.operations[0]!.moves.filter((m) => m.kind === 'rapid');
    expect(rapids.some((m) => m.z === regionRef.regionClearanceZ)).toBe(true);
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

  // XY REACH only — the cutter's own disc passes over every point, which says nothing about how
  // much material the step-over leaves standing BETWEEN rows. The scallop/cusp height against
  // the stated band is a separate claim, checked on its own analytic 18° fixture below.
  it('XY reach: every point of the footprint, inset by the cutter radius, is within the cutter radius of some posted feed', () => {
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

// The manager's own instruction: don't trust either closed-form step-over derivation (the flat-
// span formula, or its slope-corrected successor) — MEASURE the cusp a given step-over actually
// leaves standing, on the tray's own 18° slope, from the posted moves, and confirm it holds the
// stated band. Red-first, not an analytical argument.
describe('#960 finish() — the ball-scallop step-over actually holds the band, measured on the 18° slope', () => {
  const SLOPE_18_DEG = -Math.tan((18 * Math.PI) / 180); // ≈ -0.3249
  const geometry = rampMesh(SLOPE_18_DEG, LENGTH, HALF);
  // `rectRegion`'s own `slopeDeg` is derived from the OUTER describe.each block's `SLOPE`
  // (-0.2) — this fixture's real geometry is the 18° slope above, so the region's STATED slope
  // must be overridden to match, or `finish()` sizes its step-over for the wrong (shallower)
  // angle than the surface it is actually dropped against (exactly the mismatch that produced
  // this test's first, much-too-large red: a step-over picked for ~11.3° cutting an 18° slope).
  const { region: regionAt11Deg, regionRef } = rectRegion(0, -100); // zBottom unused — only the step-over and the last level's own row spacing matter
  const region: RemainderRegion = { ...regionAt11Deg, slopeDeg: [0, 18], slopeMedianDeg: 18 };
  const BAND_MM = 0.1;

  it('every mid-row point, between two adjacent passes, stands no higher than the band above the true surface', () => {
    const liveSurface = clSurface(geometry, region, ball6, 3);
    const out = finish({
      cutter: ball6, region, regionRef, clSurface: liveSurface, kind: 'ball-scallop', scallopMm: BAND_MM, stepDownMm: 100,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 }, safeZMm: 10, hopZMm: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    const profile = profileOf(ball6)!;
    // One level only (`stepDownMm` wider than the region's own depth) — every pass is the LAST
    // level, the true surface, so each row's own entry.x/entry.z is a real (X, true-Z) sample.
    const rows = [...out.passes].map((p) => ({ x: p.entry[0], z: p.entry[2] })).sort((a, b) => a.x - b.x);
    expect(rows.length).toBeGreaterThan(1); // the fixture actually exercises more than one row
    // The DESIGN surface (the actual geometry the part must end up at) is the RAW plane — never
    // the ball-tip's own `z_tip = plane(x) + rise` reading, a BALL-SPECIFIC quantity that sits
    // ABOVE the raw plane everywhere except the true (uphill-offset) tangent point. Measuring
    // against `z_tip` instead of the raw plane was this test's own first, badly wrong, red
    // (0.82 mm against a 0.1 mm band): it compared the leftover to the WRONG reference.
    const rawPlane = (x: number): number => SLOPE_18_DEG * x;
    // What ALL the passes actually leave standing at a given point: each pass removes material
    // down to its OWN envelope wherever it reaches, so the final remaining height is the LOWEST
    // (most material removed) envelope among EVERY row, not just the two bracketing `xMid` — this
    // test's own THIRD wrong attempt took the min of only the bracketing pair, which missed that
    // on a slope the row that actually cleans a point near its uphill neighbour's own axis is the
    // NEXT row over again (advisor's review): a ball riding uphill contacts ahead of its own axis,
    // so the row that reaches furthest at a given x is not always one of the two nearest in x.
    // The first/last row has no wrap-around neighbour beyond the region's own edge, so within one
    // cutter radius of EITHER end the "all rows" min is missing a row that a non-edge interior
    // point would have had — an edge artifact of this finite fixture, not the step-over formula:
    // confirmed by a standalone script scanning the same closed-form rows with no edge at all,
    // which measures 0.0999 mm (not 0.1453 mm) at this exact step-over. Excluded here by the same
    // margin, one cutter radius in from each end.
    const edgeMarginMm = profile.radiusMm;
    let worstCusp = -Infinity;
    for (let i = 1; i < rows.length; i++) {
      const left = rows[i - 1]!;
      const right = rows[i]!;
      for (let t = 0; t <= 1; t += 0.02) {
        const xMid = left.x + (right.x - left.x) * t;
        if (xMid - rows[0]!.x < edgeMarginMm || rows[rows.length - 1]!.x - xMid < edgeMarginMm) continue;
        let standing = Infinity;
        for (const row of rows) standing = Math.min(standing, row.z + heightAt(profile, Math.abs(xMid - row.x)));
        const cusp = standing - rawPlane(xMid);
        worstCusp = Math.max(worstCusp, cusp);
      }
    }
    // A lower bound too, not just the upper one: a step-over far tighter than the band needs would
    // pass this test just as silently as one that is too loose fails it — exactly how the earlier
    // (wrong) quadratic formula's 0.5405 mm step-over (2.6x more rows than necessary) would have
    // slipped through unnoticed had this test only ever checked one direction.
    expect(worstCusp, `worst measured cusp, mm (band ${BAND_MM} mm, step-over ${(rows[1]!.x - rows[0]!.x).toFixed(4)} mm)`).toBeLessThanOrEqual(BAND_MM + 1e-6);
    expect(worstCusp, `worst measured cusp, mm (band ${BAND_MM} mm, step-over ${(rows[1]!.x - rows[0]!.x).toFixed(4)} mm)`).toBeGreaterThanOrEqual(BAND_MM * 0.9);
  });
});
