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

/** A plane z = slope * y — the same ramp turned so its slope runs ALONG the raster rows. */
function sweepMesh(slope: number, length: number, half: number): FeatureSource {
  const x0 = -MESH_MARGIN_MM;
  const x1 = length + MESH_MARGIN_MM;
  const y0 = -half - MESH_MARGIN_MM;
  const y1 = half + MESH_MARGIN_MM;
  const zw0 = slope * y0;
  const zw1 = slope * y1;
  return {
    triangles: {
      positions: Float32Array.from([
        x0, y0, zw0, x1, y0, zw0, x1, y1, zw1,
        x0, y0, zw0, x1, y1, zw1, x0, y1, zw1,
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: { min: [x0, y0, Math.min(zw0, zw1)], max: [x1, y1, Math.max(zw0, zw1)] },
    },
  };
}

/** A V-ridge along the diagonal y = x, its two faces at `slope` — the diagonal crease of 6b's rule. */
function creaseMesh(slope: number, length: number, half: number): FeatureSource {
  const x0 = -MESH_MARGIN_MM;
  const x1 = length + MESH_MARGIN_MM;
  const y0 = -half - MESH_MARGIN_MM;
  const y1 = half + MESH_MARGIN_MM;
  const steps = 1;
  const nx = Math.ceil((x1 - x0) / steps);
  const ny = Math.ceil((y1 - y0) / steps);
  const pos: number[] = [];
  const idx: number[] = [];
  const zOf = (x: number, y: number): number => slope * Math.abs(x - y);
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const x = x0 + (i / nx) * (x1 - x0);
      const y = y0 + (j / ny) * (y1 - y0);
      pos.push(x, y, zOf(x, y));
    }
  }
  const at = (i: number, j: number): number => i * (ny + 1) + j;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      idx.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  let zmin = Infinity;
  let zmax = -Infinity;
  for (let k = 2; k < pos.length; k += 3) {
    zmin = Math.min(zmin, pos[k]!);
    zmax = Math.max(zmax, pos[k]!);
  }
  return {
    triangles: {
      positions: Float32Array.from(pos),
      indices: Uint32Array.from(idx),
      triangleCount: idx.length / 3,
      bbox: { min: [x0, y0, zmin], max: [x1, y1, zmax] },
    },
  };
}

/** The distinct x values the finish's feed moves visit — one per raster row. */
function rasterRows(ir: ReturnType<typeof finish>['ir']): number[] {
  const xs = new Set<number>();
  for (const op of ir.operations) for (const m of op.moves) if (m.kind === 'feed') xs.add(Number(m.x.toFixed(3)));
  return [...xs].sort((a, b) => a - b);
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
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 }, safeZMm: 10, hopZMm: 3, axisPrecision: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid,
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
    // #962's tour keeps a PLANE's links down (the chord rides the CL), so the property needs a
    // join that must retract. #960's finer ball step-over passes THROUGH a narrow rise — the
    // rows follow it, which is the cut the passes exist for, so no retract is owed and none
    // happens. This fixture therefore puts the rise in a MASKED GAP between the rows: no pass
    // crosses it, the ONE join over the gap is a chord across it, the CL bulges 0.3 mm above
    // that chord, and the retract must go to the region's clearance plane.
    const base = clSurface(geometry, region, cutter, 3);
    // The gap is long (25 mm) and the feed is the ball's own catalogue rate (F500): the
    // dip-following link's TIME GUARD refuses it (the follow would out-run the retract), so the
    // join must retract — and a retract must transit the REGION's clearance plane, never a hop.
    const risen: typeof base = {
      ...base,
      dropCutter: (x: number, y: number) => {
        const z = base.dropCutter(x, y);
        return z === null ? null : x >= 14 && x <= 15 ? z + 0.3 : z;
      },
    };
    const out = finish({
      cutter, region, regionRef, clSurface: risen, kind, scallopMm: 0.1, stepDownMm: 2,
      maskCells: (x: number) => !(x > 5 && x < 30),
      feeds: { feedMmPerMin: 500, plungeFeedMmPerMin: 300 }, safeZMm: 10, hopZMm: 3, axisPrecision: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    const rapids = out.ir.operations[0]!.moves.filter((m) => m.kind === 'rapid');
    expect(rapids.some((m) => m.z === regionRef.regionClearanceZ), 'the rise was crossed without a retract').toBe(true);
  });

  it('a provable rise is FOLLOWED, not chording below it: the feeds ride the CL over it (#962)', () => {
    // A short gap over the rise with the cutting rate to match: the dip-following link takes it,
    // and every feed over the rise sits at the risen CL — the ball cuts the rise exactly as the
    // passes either side do, and never a chord below it (which would be a gouge).
    const base = clSurface(geometry, region, cutter, 3);
    const risen: typeof base = {
      ...base,
      dropCutter: (x: number, y: number) => {
        const z = base.dropCutter(x, y);
        return z === null ? null : x >= 7.5 && x <= 8.5 ? z + 0.3 : z;
      },
    };
    const out = finish({
      cutter, region, regionRef, clSurface: risen, kind, scallopMm: 0.1, stepDownMm: 2,
      maskCells: (x: number) => !(x > 5 && x < 11),
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 }, safeZMm: 10, hopZMm: 3, axisPrecision: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    const moves = out.ir.operations[0]!.moves;
    // FOLLOWED, not a chord: a chord would be ONE move from the row at x ≈ 4.5 straight to the
    // row at x ≈ 11, with nothing in between; a follow is a sampled path with feeds INSIDE the
    // gap. And it is not a retract: no rapid sits at the region's clearance plane between them.
    const inGap = moves.filter((m) => m.kind === 'feed' && m.x > 7.5 && m.x < 8.5);
    expect(inGap.length, 'the join over the rise was not followed — no feed crosses it').toBeGreaterThan(0);
    const clearRapids = moves.filter((m) => m.kind === 'rapid' && m.z === regionRef.regionClearanceZ);
    expect(clearRapids.length, 'the follow was replaced by a retract to the clearance plane').toBe(0);
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
        // #1052 — EACH CELL IS CUT ONCE, in the level whose band holds its CL: a level's deepest
        // move is the deepest sample INSIDE its band, which sits up to one row's own surface step
        // above the band floor (this fixture's 1.49 mm rows on a 0.2 slope ≈ 0.3 mm), so the step
        // between two levels' deepest moves is stepDownMm plus that sampling step — not exactly
        // stepDownMm, which only held while every level re-rastered the whole span at its floor.
        expect(prevDeepest - deepest, `level at ${levelKey}: deepest move ${deepest} after previous level's own deepest ${prevDeepest}`).toBeLessThanOrEqual(2 + 0.5);
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
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 }, safeZMm: 10, hopZMm: 3, axisPrecision: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid,
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


/**
 * #1080 — THE SLOPE THE STEP-OVER READS IS THE CROSS-ROW COMPONENT (6b's ruling).
 *
 * The finish sizes its step-over from the region's slope per band (#960), but both reads took the
 * gradient MAGNITUDE: a wall running ALONG the rows pinned every band at its own steep angle even
 * though no cusp exists across the rows. The reads now take |∂z/∂x| — the direction the rows
 * advance — so a slope along the rows reads ≈0° and keeps the gentle spacing.
 */
describe('#1080 the finish reads the cross-row slope, not the gradient magnitude', () => {
  const job = (geometry: FeatureSource) => {
    const surface = clSurface(geometry, rectRegion(0, -100).region, ball6, 3);
    const deepest = Math.min(
      surface.dropCutter(LENGTH - PAD - 0.01, -HALF + PAD + 0.01)!,
      surface.dropCutter(LENGTH - PAD - 0.01, HALF - PAD - 0.01)!,
    );
    const { region, regionRef } = rectRegion(0, deepest - 1e-6);
    return finish({
      cutter: ball6, region, regionRef, clSurface: clSurface(geometry, region, ball6, 3), kind: 'ball-scallop',
      scallopMm: 0.1, stepDownMm: 2, feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      safeZMm: 10, hopZMm: 3, axisPrecision: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
  };

  it('a 60° wall ALONG the rows reads ≈0°; the same wall ACROSS the rows reads 60° (6b’s units)', () => {
    // The wall runs at 60° from horizontal: slope tan(60°) = 1.732. Along the rows the cross-row
    // component is 0, so the pitch conversion is the identity — but the band is a VERTICAL cusp,
    // and on a 60° surface a 0.1 mm vertical band is only 0.05 mm along the normal (6b's split
    // cosines, #1080): the along-row spacing is 2*sqrt(2R*h_n - h_n^2) with h_n = band*cos 60°,
    // ≈1.091 mm — neither the flat 1.536 mm nor half of it. Across the rows the ball at a 0.1 mm
    // cusp needs ~0.545 mm, as before.
    const steepSlope = Math.tan((60 * Math.PI) / 180);
    const along = rasterRows(job(sweepMesh(steepSlope, LENGTH, HALF)).ir);
    const across = rasterRows(job(rampMesh(-steepSlope, LENGTH, HALF)).ir);
    const cos60 = Math.cos((60 * Math.PI) / 180);
    const normalBand = 0.1 * cos60;
    const alongStep = 2 * Math.sqrt(2 * 3 * normalBand - normalBand ** 2); // ≈1.091 mm
    const alongRows = Math.floor((LENGTH - 2 * PAD) / alongStep) + 2;
    const steepStep = cos60 * 2 * Math.sqrt(2 * 3 * (0.1 * cos60) - (0.1 * cos60) ** 2); // ≈0.545 mm
    const steepRows = Math.floor((LENGTH - 2 * PAD) / steepStep) + 2;
    expect(Math.abs(along.length - alongRows), `along-row rows ${along.length} vs h_n step ~${alongRows}`).toBeLessThanOrEqual(3);
    expect(across.length, `across-rows rows ${across.length} vs steep ~${steepRows}`).toBeGreaterThan(along.length + 20);
  }, 240_000);

  it('the split cosines, in units: a 60° along-row plane gives the h_n = band·cos60 step, neither the flat spacing nor half of it', () => {
    const steepSlope = Math.tan((60 * Math.PI) / 180);
    const rows = rasterRows(job(sweepMesh(steepSlope, LENGTH, HALF)).ir);
    const cos60 = Math.cos((60 * Math.PI) / 180);
    const alongStep = (band: number) => 2 * Math.sqrt(2 * 3 * (band * cos60) - (band * cos60) ** 2);
    const flatStep = 2 * Math.sqrt(2 * 3 * 0.1 - 0.1 * 0.1); // ≈1.536 mm
    // The tightest gap between rows is the band's own step: h_n = 0.1·cos60 gives ≈1.091 mm.
    let minGap = Infinity;
    for (let i = 1; i < rows.length; i++) minGap = Math.min(minGap, rows[i]! - rows[i - 1]!);
    // The row guard's phase snapping moves a gap a couple of percent; the step must be this one.
    expect(Math.abs(minGap - alongStep(0.1)), `tightest gap ${minGap.toFixed(4)} vs h_n step ${alongStep(0.1).toFixed(4)}`).toBeLessThan(0.05);
    expect(Math.abs(minGap - flatStep)).toBeGreaterThan(0.2); // not the flat spacing
    expect(Math.abs(minGap - flatStep / 2)).toBeGreaterThan(0.2); // not half of it
  }, 240_000);
});

/**
 * #1080 (6b's follow-up ruling) — THE STRAIGHT-STRIP GATE.
 *
 * The cross-row component is right only where the strip's CL is STRAIGHT across it. The test is
 * the second difference across the row sampling, |z(xc+h) − 2·z(xc) + z(xc−h)| over the strip's y
 * samples: above the job's scallop the bin is not a straight run and takes the gradient-magnitude
 * read again — the pre-#1080 read, so every card's leftover is what it was.
 */
describe('#1080 the cross-row read is gated on a straight strip', () => {
  const job = (geometry: FeatureSource) => {
    const surface = clSurface(geometry, rectRegion(0, -100).region, ball6, 3);
    const deepest = Math.min(
      surface.dropCutter(LENGTH - PAD - 0.01, -HALF + PAD + 0.01)!,
      surface.dropCutter(LENGTH - PAD - 0.01, HALF - PAD - 0.01)!,
    );
    const { region, regionRef } = rectRegion(0, deepest - 1e-6);
    return finish({
      cutter: ball6, region, regionRef, clSurface: clSurface(geometry, region, ball6, 3), kind: 'ball-scallop',
      scallopMm: 0.1, stepDownMm: 2, feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      safeZMm: 10, hopZMm: 3, axisPrecision: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
  };

  it('a diagonal crease bin is not straight and reads the magnitude: its rows take the finer spacing', () => {
    // The V-ridge's faces are at 60°; the cross-row read sees 60° (the vertex sample's face), the
    // magnitude atan(tan60·√2) = 67.79°. The second difference at the crease is 2·slope·h = 0.35 mm,
    // far over the 0.1 mm scallop, so the bin takes the magnitude and its rows the finer step.
    const steepSlope = Math.tan((60 * Math.PI) / 180);
    const rows = rasterRows(job(creaseMesh(steepSlope, LENGTH, HALF)).ir);
    expect(rows.length).toBeGreaterThan(2);
    let minGap = Infinity;
    for (let i = 1; i < rows.length; i++) minGap = Math.min(minGap, rows[i]! - rows[i - 1]!);
    const magDeg = (Math.atan(steepSlope * Math.SQRT2) * 180) / Math.PI;
    const cosT = Math.cos((magDeg * Math.PI) / 180);
    const magStep = cosT * 2 * Math.sqrt(2 * 3 * (0.1 * cosT) - (0.1 * cosT) ** 2);
    // RED at 3cce4dd83: the crease's bins read 60° and the tightest gap is the 0.54 mm step; the
    // magnitude's is 0.36 mm. The allowance covers the row guard's snap to the old grid.
    expect(minGap, `tightest row gap ${minGap.toFixed(3)} mm against the magnitude's ${magStep.toFixed(3)} mm`).toBeLessThan(magStep * 1.15);
  }, 240_000);
});
