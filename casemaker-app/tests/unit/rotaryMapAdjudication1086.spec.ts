/**
 * #1086 — THE MAP FRAME'S UNADJUDICABLE CELLS. The exact stamp is still a heightfield read: a cell
 * on a design cliff carries the wall's TOP radius, while the stamp holds the neighbouring pass's
 * cutter surface, so the cell reads as cut-into though the tool never reached the top. The flat
 * check has three proofs for this class (#955 wall cells, #970 wall shadow on the CL, #996
 * straddling); this spec pins the map frame's own versions and — red-first — that a real gouge in
 * a smooth region is never excused by them.
 *
 * The fixtures are the #1083/#1086 synthetic rod: ⌀20 (R 10), 0.2 mm pitch, one full turn.
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
import type { ColumnGrid } from '@/workers/geometry/columnEngine';
import type { GoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import { stampProfile, stampRotarySweptField } from '@/workers/sim/sweptPoint';
import { checkGoalCutIntoRotary } from '@/workers/sim/goalCheckRotary';

const R = 10;
const PITCH = 0.2;
const NX = 50;
const NY = 315;
const DV = 360 / NY;

/** The goal: plateau at the rod's surface, with a band of `depth`mm cut over rows [lo, hi). */
function goalWithBand(lo: number, hi: number, depth: number): GoalRadialField {
  const z = new Float32Array(NX * NY);
  for (let j = lo; j < hi; j++) for (let i = 0; i < NX; i++) z[j * NX + i] = -depth;
  return {
    nx: NX,
    ny: NY,
    x0: 0,
    y0: 0,
    pitch: PITCH,
    radius: R,
    minRadius: R - depth,
    maxRadius: R,
    z,
    covered: new Uint8Array(NX * NY).fill(1),
    coveredCount: NX * NY,
    // #1164 (b) — a synthetic field casts no beyond-rod cells.
    recastCells: 0,
    degenerateCells: 0,
    resolutionNote: 'synthetic',
  };
}

const designAt = (goal: GoalRadialField, i: number, j: number): number => R + goal.z[j * NX + i]!;

/** The uncut column grid: the coarse model, only the beside-it diagnostic here. */
function uncutGrid(): ColumnGrid {
  return { kind: 'rotary', nu: NX, nv: NY, u0: 0, du: PITCH, v0: 0, dv: DV, initial: R, base: 0, h: new Float32Array(NX * NY).fill(R) };
}

/** Raster every row at its design radius, then optional plunges. */
function program(goal: GoalRadialField, plunges: readonly { i: number; j: number; z: number }[] = []): ReturnType<typeof movesFor> {
  return movesFor(goal, plunges);
}

/** The map's own angle for row j (arc j·pitch at the design radius), so the moves land on the grid. */
const vOf = (j: number): number => ((j * PITCH) / R) * (180 / Math.PI);

function movesFor(goal: GoalRadialField, plunges: readonly { i: number; j: number; z: number }[]) {
  const moves = [];
  for (let j = 0; j < NY; j++) {
    const v = vOf(j);
    moves.push({ step: 0, line: 1, u0: 0, u1: (NX - 1) * PITCH, v0: v, v1: v, z: designAt(goal, 0, j), z0: designAt(goal, 0, j), z1: designAt(goal, 0, j) });
  }
  for (const p of plunges) {
    moves.push({ step: 0, line: 2, u0: p.i * PITCH, u1: p.i * PITCH, v0: vOf(p.j), v1: vOf(p.j), z: p.z, z0: p.z, z1: p.z });
  }
  return moves;
}

const PASS_LO = 150;
const PASS_HI = 157;
const PASS_DEPTH = 3;

describe('#1086 the rotary map adjudication', () => {
  it('excuses the cliff cells and the CL-proven shadow, but a smooth-region gouge stays adjudicated', () => {
    const goal = goalWithBand(PASS_LO, PASS_HI, PASS_DEPTH);
    // A real 0.5 mm gouge on the plateau at (x 5, row 50), far from every wall.
    const exact = stampRotarySweptField(
      goal,
      () => R,
      program(goal, [{ i: 25, j: 50, z: R - 0.5 }]),
      stampProfile(flatEndMill(2)),
    );
    expect(exact).not.toBeNull();
    // The raw stamp reads the cliff's phantom too: the pass's disc reaches the top cells.
    const raw = checkGoalCutIntoRotary(goal, uncutGrid(), null, {}, undefined, exact);
    expect(raw.cutIntoFraction).toBeGreaterThan(0.01);
    expect(raw.maxCutIntoMm).toBeCloseTo(PASS_DEPTH, 5); // the phantom is the worst RAW cell
    expect(raw.wallNotScoredFraction).toBeGreaterThan(0);
    // With the shadow radius stated and the CL known to have stayed away from every wall, the
    // heightfield's blind classes are excused and the smooth gouge is what the verdict keeps.
    const adjudicated = checkGoalCutIntoRotary(
      goal,
      uncutGrid(),
      null,
      { wallShadowRadiusMm: 1, clAt: () => ({ x: 5, y: 10 }) },
      undefined,
      exact,
    );
    expect(adjudicated.wallNotScoredFraction).toBeGreaterThan(0);
    expect(adjudicated.shadowNotScoredFraction).toBeGreaterThan(0);
    expect(adjudicated.straddlingNotScoredCells).toBe(0);
    expect(adjudicated.adjudicatedMaxMm).toBeCloseTo(0.5, 5);
    // A flat disc leaves one depth over its whole footprint: the worst cell is any of them.
    expect(Math.abs((adjudicated.adjudicatedMaxAt?.x ?? Infinity) - 5)).toBeLessThanOrEqual(1);
    expect(adjudicated.adjudicatedFraction).toBeGreaterThan(0);
    expect(adjudicated.adjudicatedFraction).toBeLessThan(raw.cutIntoFraction);
    expect(adjudicated.sentence).toContain('wall/border');
  }, 120_000);

  it('does not blanket-excuse a shadow cell whose CL stayed at the wall', () => {
    const goal = goalWithBand(PASS_LO, PASS_HI, PASS_DEPTH);
    const exact = stampRotarySweptField(goal, () => R, program(goal), stampProfile(flatEndMill(2)));
    const report = checkGoalCutIntoRotary(
      goal,
      uncutGrid(),
      null,
      // The deepest stamp stood ON the wall row: the v5 proof is not met, so the cell is judged.
      { wallShadowRadiusMm: 1, clAt: () => ({ x: 5, y: PASS_LO * PITCH }) },
      undefined,
      exact,
    );
    expect(report.shadowNotScoredFraction).toBe(0);
    expect(report.adjudicatedMaxMm).toBeCloseTo(PASS_DEPTH, 5);
    expect(report.adjudicatedFraction).toBeGreaterThan(0);
  }, 120_000);

  it('excuses a straddling cell on proof, and judges the same cell when the cut went below the low side', () => {
    const goal = goalWithBand(PASS_LO, PASS_HI, 0.15);
    const t = flatEndMill(0.4); // reach 0.2 mm: one cell, so the plunge isolates the straddling case
    // 0.12 mm below the top, still at/above the 0.15 mm step's low side: excused on proof.
    const excused = stampRotarySweptField(
      goal,
      () => R,
      program(goal, [{ i: 25, j: PASS_LO - 1, z: 9.88 }]),
      stampProfile(t),
    );
    const pass = checkGoalCutIntoRotary(goal, uncutGrid(), null, {}, undefined, excused);
    expect(pass.cutIntoFraction).toBeGreaterThan(0);
    expect(pass.straddlingNotScoredCells).toBe(1);
    expect(pass.straddlingMaxStepMm).toBeCloseTo(0.15, 5);
    expect(pass.adjudicatedFraction).toBe(0);

    // 0.3 mm below the top: deeper than the step, so it went below the low side — judged.
    const gouged = stampRotarySweptField(
      goal,
      () => R,
      program(goal, [{ i: 25, j: PASS_LO - 1, z: 9.7 }]),
      stampProfile(t),
    );
    const report = checkGoalCutIntoRotary(goal, uncutGrid(), null, {}, undefined, gouged);
    expect(report.straddlingNotScoredCells).toBe(0);
    expect(report.adjudicatedMaxMm).toBeCloseTo(0.3, 5);
    expect(report.adjudicatedFraction).toBeGreaterThan(0);
  }, 120_000);
});
