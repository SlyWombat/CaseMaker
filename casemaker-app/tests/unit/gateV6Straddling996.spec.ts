/**
 * #996 — GATE v6, THE STRADDLING-CELL EXCUSE ON PROOF. RED-FIRST.
 *
 * A cut-into cell whose centre sits on a vertical step reads the step's high side while the cutter
 * correctly stops at the step; the honest test is the design's LOW side over the cell. The excuse is
 * bounded: the step actually straddled must be at least as tall as the read intrusion (a one-cell
 * gouge on flat ground has step 0 and can never qualify), and the swept floor must be at the
 * design's low side (within STRADDLING_SLACK_MM). Excused cells are counted and their tallest step
 * printed, never silent.
 */
import { describe, expect, it } from 'vitest';

import { STRADDLING_SLACK_MM, checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

const PITCH = 1;
const N = 24;

/** A fully covered grid whose z is `z(i, j)`, cell-centred at `pitch` 1. */
function field(z: (i: number, j: number) => number): GoalHeightfield {
  const covered = new Uint8Array(N * N).fill(1);
  const values = new Float32Array(N * N);
  let minZ = Infinity;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = z(i, j);
      values[j * N + i] = v;
      minZ = Math.min(minZ, v);
    }
  }
  return { nx: N, ny: N, x0: 0, y0: 0, pitch: PITCH, topZ: 0, minZ, z: values, covered, coveredCount: N * N, resolutionNote: '#996 straddling fixture' };
}

/** The swept-top reader: the goal plus a raise, minus the cut, per cell centre. */
function reader(goal: GoalHeightfield, cut: Map<number, number>): (x: number, y: number) => number | null {
  return (x, y) => {
    const i = Math.round((x - goal.x0) / goal.pitch);
    const j = Math.round((y - goal.y0) / goal.pitch);
    if (i < 0 || j < 0 || i >= goal.nx || j >= goal.ny) return null;
    const k = j * goal.nx + i;
    return (goal.z[k] as number) - (cut.get(k) ?? 0);
  };
}
const at = (i: number, j: number): number => j * N + i;

const LOW = -3.8;

describe('#996 the straddling-cell excuse is on proof', () => {
  it('a 0.3 mm one-cell gouge on flat ground is NOT excused (step 0 can never reach the intrusion)', () => {
    const goal = field(() => LOW);
    const swept = reader(goal, new Map([[at(5, 5), 0.3]]));
    const r = checkGoalCutInto(goal, swept);
    expect(r.straddlingNotScoredCells, 'flat ground has no step to straddle').toBe(0);
    expect(r.straddlingMaxStepMm).toBe(0);
    expect(r.adjudicatedFraction, 'the gouge cell is judged').toBeGreaterThan(0);
    expect(r.adjudicatedMaxAt).toEqual({ x: 5, y: 5 });
  });

  it('a cell on a 0.11 mm step, with the swept floor at the low side, is excused on proof', () => {
    // The step: i >= 8 is 0.11 mm above the floor (below the 0.2 mm design-edge rule, so not a
    // wall cell); the cell whose centre reads the high side is the one the excuse exists for.
    const goal = field((i) => (i >= 8 ? LOW + 0.11 : LOW));
    // A 0.105 mm intrusion: past the 0.1 mm adjudication floor (the cell is JUDGED), no taller than
    // the 0.11 mm step, and the swept floor is still above the design's low side — the organizer's
    // own case (its centre reads the step's high side while the cutter stops at the step).
    const swept = reader(goal, new Map([[at(8, 5), 0.105]]));
    const r = checkGoalCutInto(goal, swept);
    expect(r.straddlingNotScoredCells, 'the cell straddles the 0.11 mm step and sits at its low side').toBe(1);
    expect(r.straddlingMaxStepMm).toBeCloseTo(0.11, 5); // the heightfield is float32
    expect(r.adjudicatedFraction, 'nothing is judged once the straddling cell is excused').toBe(0);
    expect(r.sentence).toContain('1 cell on a 0.110 mm step, excused on proof');
  });

  it('the same cell 0.02 mm below the low side is NOT excused', () => {
    const goal = field((i) => (i >= 8 ? LOW + 0.11 : LOW));
    // Swept floor 0.02 mm below the design's low side: more than STRADDLING_SLACK_MM (0.005).
    const swept = reader(goal, new Map([[at(8, 5), 0.11 + 0.02]]));
    const r = checkGoalCutInto(goal, swept);
    expect(r.straddlingNotScoredCells, 'the floor left the low side by more than the slack').toBe(0);
    expect(r.adjudicatedFraction, 'the cell is judged').toBeGreaterThan(0);
    expect(STRADDLING_SLACK_MM).toBeLessThan(0.02);
  });

  it('a cell on a 0.5 mm step stays in the WALL class and is never double-counted', () => {
    const goal = field((i) => (i >= 12 ? LOW + 0.5 : LOW));
    // A 0.105 mm intrusion on the wall cell itself: judged at the floor, then the WALL class takes
    // it (its step is 0.5 mm > 0.2) — the straddling class must never see it.
    const swept = reader(goal, new Map([[at(12, 5), 0.105]]));
    const r = checkGoalCutInto(goal, swept);
    expect(r.wallNotScoredFraction, 'a 0.5 mm step is a design edge').toBeGreaterThan(0);
    expect(r.straddlingNotScoredCells, 'wall cells are decided first — the straddling class never sees them').toBe(0);
  });
});
