/**
 * #1087 — THE ROTARY FINISH HOLDS THE STATED SCALLOP.
 *
 * The relief's finish used to step at the feeds row's 45 % step-over (0.9 mm on a ⌀2 ball), whose
 * own cusp is 0.107 mm — above the goal check's 0.1 mm band, so a covering pass read 6.35 %
 * standing. The fix takes the step from the stated scallop (`ballScallopStepOver`, the model
 * plan's own rule), quantised DOWN to the field grid (never rounded up — the raster rows are grid
 * indices), and states the cusp the step actually leaves.
 *
 * THE FIXTURE is a synthetic sphere on the rod — a revolved solid, so the surface between two
 * adjacent A-rows is flat in the direction the rows step: the cusp the step promises is exactly
 * `R − √(R² − (s/2)²)`, the arithmetic #1087 was filed with. The assertions read the step the
 * program's own rows were cut at (the wrapped moves' A values), not a re-derived formula.
 */
import { describe, expect, it } from 'vitest';

import { generateRotaryReliefIR, sampleGoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import { ballScallopCusp, ballScallopStepOver } from '@/engine/cnc/ballScallop';
import { type SurfaceFeeds } from '@/engine/cnc/cam/surfaceFinishTipField';
import { flatEndMill } from '@/engine/cnc/tool';
import type { RapidEstimate } from '@/engine/cnc/cam/ir';
import type { EngraveTargetObject } from '@/types/engraveJob';
import { stl } from './helpers/meshes';

type V = [number, number, number];
type Tri = [V, V, V];

/** A UV sphere of radius `r` sitting on the rod: centred at (0, 0, R) in the mesh's own frame. */
function sphereTris(r: number, centreZ: number, seg = 48, rings = 24): Tri[] {
  const at = (theta: number, phi: number): V => [
    r * Math.sin(theta) * Math.cos(phi),
    r * Math.sin(theta) * Math.sin(phi),
    centreZ + r * Math.cos(theta),
  ];
  const tris: Tri[] = [];
  for (let i = 0; i < rings; i++) {
    const t0 = (i / rings) * Math.PI;
    const t1 = ((i + 1) / rings) * Math.PI;
    for (let j = 0; j < seg; j++) {
      const p0 = (j / seg) * 2 * Math.PI;
      const p1 = ((j + 1) / seg) * 2 * Math.PI;
      tris.push([at(t0, p0), at(t1, p0), at(t1, p1)], [at(t0, p0), at(t1, p1), at(t0, p1)]);
    }
  }
  return tris;
}

const R = 10;
const CX = 30;
const BALL = flatEndMill(2, { shape: 'ball', name: '2 mm ball', fluteLength: 12, shoulderLength: 20 });
const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test' };
const FEEDS: SurfaceFeeds = { feed: 600, plungeFeed: 200, stepDown: 1.5, roughStepOver: 1.2, finishStepOver: 0.9 };
const SCALLOP = 0.027;

function sphereGoal(): EngraveTargetObject {
  return {
    id: 'sphere',
    name: 'sphere.stl',
    format: 'stl',
    sha256: 'f'.repeat(64),
    data: stl(sphereTris(6, R)),
    size: { x: 12, y: 12, z: 12 },
    // The seam at 90° of arc keeps the appended last raster row clear of the sphere: every row the
    // finish cuts is on the stride, so the spacing read off the moves is the step itself.
    position: { x: CX, y: (Math.PI * R) / 2, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

const build = (pitchMm: number, finishScallopMm?: number) =>
  generateRotaryReliefIR({
    field: sampleGoalRadialField(sphereGoal(), R, { pitchMm }),
    tool: BALL,
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    axisPrecision: 3,
    feeds: FEEDS,
    rapid: RAPID,
    stockToLeaveMm: 0.2,
    ...(finishScallopMm === undefined ? {} : { finishScallopMm }),
  });

/** The distinct A values (degrees) the finish op's cutting moves were made at, ascending. */
function rowAnglesDeg(r: ReturnType<typeof generateRotaryReliefIR>): number[] {
  const set = new Set<number>();
  for (const m of r.finishing.moves) {
    if (m.kind === 'feed' && m.a !== undefined) set.add(Number(m.a.toFixed(9)));
  }
  return [...set].sort((x, y) => x - y);
}

describe('#1087 the rotary finish takes its step from the stated scallop', () => {
  it('the cusp rule is the model plan’s own, and its inverse round-trips', () => {
    // The issue's arithmetic: a ⌀2 ball at a 0.027 mm cusp steps 0.4616 mm; at 0.9 mm it leaves
    // 0.107 mm standing — over the goal check's 0.1 mm band.
    expect(ballScallopStepOver(1, SCALLOP, 0, 0)).toBeCloseTo(0.4616, 4);
    expect(ballScallopCusp(1, 0.9)).toBeCloseTo(0.107, 3);
    expect(ballScallopCusp(1, 0.4)).toBeCloseTo(0.0202, 4);
    // Stepping from a cusp and reading the cusp back is the same number.
    expect(ballScallopCusp(1, ballScallopStepOver(1, SCALLOP, 0, 0))).toBeCloseTo(SCALLOP, 9);
  });

  it('steps at the grid multiple whose cusp is under the scallop, never rounding up', () => {
    const out = build(0.1, SCALLOP);
    // 0.4616 is 4.6 cells of the 0.1 mm grid: the step floors to 0.4 (cusp 0.0202 ≤ 0.027), never
    // rounds up to 0.5 (cusp 0.0318 > 0.027).
    expect(out.finish.stepOverMm).toBeCloseTo(0.4, 9);
    expect(out.finish.cuspMm).toBeCloseTo(0.0202, 4);
    expect(out.finish.cuspMm!).toBeLessThanOrEqual(SCALLOP);
    expect(out.finish.scallopMm).toBe(SCALLOP);
    expect(out.finish.gridLimited).toBe(false);
    // The program's own rows stand at that step: consecutive row A values are 0.4 mm of arc apart.
    const rows = rowAnglesDeg(out);
    expect(rows.length).toBeGreaterThan(4);
    const arcMm = rows.slice(1).map((a, i) => ((a - rows[i]!) * Math.PI * R) / 180);
    expect(Math.min(...arcMm)).toBeCloseTo(0.4, 6);
    expect(arcMm.some((d) => Math.abs(d - 0.5) < 1e-6)).toBe(false);
  });

  it('a grid too coarse to reach the cusp states the limit rather than hiding it', () => {
    // At a 0.5 mm field pitch the closest row is one cell = 0.5 mm: cusp 0.0318 mm, over the
    // 0.027 asked for. The result says so; the run sheet prints it.
    const out = build(0.5, SCALLOP);
    expect(out.finish.stepOverMm).toBeCloseTo(0.5, 9);
    expect(out.finish.gridLimited).toBe(true);
    expect(out.finish.cuspMm!).toBeCloseTo(0.031754, 6);
    expect(out.finish.cuspMm!).toBeGreaterThan(SCALLOP);
  });

  it('a caller that states no scallop keeps the feeds row’s step and STATES the cusp it leaves', () => {
    const out = build(0.1);
    expect(out.finish.stepOverMm).toBe(FEEDS.finishStepOver);
    // #1087 — the step stays the feeds row's; the cusp that step leaves is still stated, because
    // 0.9 mm on a ⌀2 ball is 0.107 mm — above the goal check's 0.1 mm band — and two constants
    // must not disagree in silence. Only `scallopMm` (nothing was asked for) stays null.
    expect(out.finish.cuspMm).toBeCloseTo(ballScallopCusp(1, FEEDS.finishStepOver), 9);
    expect(out.finish.scallopMm).toBeNull();
    expect(out.finish.gridLimited).toBe(false);
  });
});
