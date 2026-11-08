/**
 * #1086 — THE ROTARY GOAL'S EXACT STAMP. The rotary check judges the goal against the column
 * grid read through the run's map tolerance; that tolerance hides any real gouge smaller than half
 * a cell plus the cutter's facet, so the #1059 readiness job's 14.9 % tail is unadjudicated. The
 * fix is the flat path's own answer in the map frame: stamp the posted program's moves onto the
 * goal's (X, θ) grid and judge the exact remaining radius per cell, keeping the column read as a
 * stated diagnostic.
 *
 * The fixtures are the #1083 spec's synthetic rod: ⌀20 (R 10), 0.2 mm goal pitch, a flat ⌀2 tool.
 * RED at the base: `stampRotarySweptField` does not exist (the import fails), and the check has no
 * exact argument.
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
import type { CutMove } from '@/workers/geometry/columnEngine';
import type { ColumnGrid } from '@/workers/geometry/columnEngine';
import type { GoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import { stampProfile, stampRotarySweptField } from '@/workers/sim/sweptPoint';
import { checkGoalCutIntoRotary } from '@/workers/sim/goalCheckRotary';

const R = 10;
const PITCH = 0.2;
const NX = 50; // 10 mm of X at the pitch
const NY = 315; // one full turn at the pitch
const TOOL = flatEndMill(2); // ⌀2 flat: a 1 mm disc, a zero rise

/** The goal: the rod's own surface everywhere, fully covered. */
function goalField(): GoalRadialField {
  return {
    nx: NX,
    ny: NY,
    x0: 0,
    y0: 0,
    pitch: PITCH,
    radius: R,
    minRadius: R,
    maxRadius: R,
    z: new Float32Array(NX * NY),
    covered: new Uint8Array(NX * NY).fill(1),
    coveredCount: NX * NY,
    resolutionNote: 'synthetic',
  };
}

const dv = 360 / NY;

/** The program: a pass along X on every row at the design radius, plus optional gouge plunges. */
function program(gouges: readonly { x: number; v: number; z: number }[] = []): CutMove[] {
  const moves: CutMove[] = [];
  for (let j = 0; j < NY; j++) {
    const v = j * dv;
    moves.push({ step: 0, line: 1, u0: 0, u1: (NX - 1) * PITCH, v0: v, v1: v, z: R, z0: R, z1: R });
  }
  for (const g of gouges) moves.push({ step: 0, line: 2, u0: g.x, u1: g.x, v0: g.v, v1: g.v, z: g.z, z0: g.z, z1: g.z });
  return moves;
}

/** The columns, uncut (the stock's radius everywhere) — the coarse model that hides a gouge. */
function uncutGrid(): ColumnGrid {
  return { kind: 'rotary', nu: NX, nv: NY, u0: 0, du: PITCH, v0: 0, dv, initial: R, base: 0, h: new Float32Array(NX * NY).fill(R) };
}

const GOUGE = { x: 5, v: 90, z: R - 0.3 } as const;

describe('#1086 the rotary exact stamp', () => {
  it('stamps the program onto the goal grid: a cut at the design reads the design, a plunge reads its tip', () => {
    const field = stampRotarySweptField(goalField(), () => R, program([GOUGE]), stampProfile(TOOL));
    expect(field).not.toBeNull();
    const at = (x: number, v: number): number => {
      const i = Math.round(x / PITCH);
      const j = ((Math.round(v / dv) % NY) + NY) % NY;
      return field![j * NX + i]!;
    };
    // The passes cut everything to the design radius; the gouge's own cells read its tip.
    expect(at(2, 45)).toBeCloseTo(R, 5);
    expect(at(GOUGE.x, GOUGE.v)).toBeCloseTo(R - 0.3, 5);
    expect(at(GOUGE.x + 0.6, GOUGE.v)).toBeCloseTo(R - 0.3, 5);
    // Near the gouge's edge the disc rises: a cell just past its reach stays at the design.
    expect(at(GOUGE.x + 1.4, GOUGE.v)).toBeCloseTo(R, 5);
  }, 120_000);

  it('a gouge the column model excuses is the stamp’s cut-into, with the column read beside it', () => {
    // The run's own map tolerance — the same terms #1083's last case uses — excuses a 0.3 mm
    // gouge on the coarse grid. The stamp has no cell/facet allowance: the gouge is the verdict,
    // and the column read stays as the stated diagnostic.
    const allowance = { cellMm: 0.1, facetAt: (): number => 0.3 };
    const goal = goalField();
    const exact = stampRotarySweptField(goal, () => R, program([GOUGE]), stampProfile(TOOL));
    const column = checkGoalCutIntoRotary(goal, uncutGrid(), null, {}, allowance);
    expect(column.cutIntoFraction).toBe(0); // the model excuses the 0.3 mm gouge
    const stamped = checkGoalCutIntoRotary(goal, uncutGrid(), null, {}, allowance, exact);
    expect(stamped.ran).toBe(true);
    expect(stamped.cutIntoFraction).toBeGreaterThan(0);
    expect(stamped.maxCutIntoMm).toBeCloseTo(0.3, 5);
    // A flat disc leaves one depth over its whole footprint: the worst cell is any of them, so
    // the coordinate is pinned to the gouge's disc, not to a point.
    expect(Math.abs((stamped.maxCutIntoAt?.x ?? Infinity) - GOUGE.x)).toBeLessThanOrEqual(1);
    // One disc's reach is 1 mm of arc — 5.73° at R 10 — so the plateau spans that either side.
    expect(Math.abs((stamped.maxCutIntoAt?.y ?? Infinity) - GOUGE.v)).toBeLessThanOrEqual(6);
    // The column read is kept, not replaced.
    expect(stamped.columnCutInto?.fraction).toBe(0);
  }, 120_000);

  it('an exact cut reads no cut-into under the stamp, and the tolerance still forgives the floor’s dust', () => {
    const goal = goalField();
    const exact = stampRotarySweptField(goal, () => R, program(), stampProfile(TOOL));
    const report = checkGoalCutIntoRotary(goal, uncutGrid(), null, {}, { cellMm: 0.1, facetAt: () => 0.3 }, exact);
    expect(report.cutIntoFraction).toBe(0);
    expect(report.maxCutIntoMm).toBe(0);
    expect(report.coverageFraction).toBeGreaterThan(0.99);
  }, 120_000);
});
