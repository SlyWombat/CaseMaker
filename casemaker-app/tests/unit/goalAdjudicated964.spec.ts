// #964 — THE WALL EXCLUSION APPLIES TO EVERY GOAL JOB (and, since v5, the wall shadow only on
// the proof the rule states).
//
// E's top-clamp re-run on d1851598: the RAW fields agreed exactly with the page (1,932 cells,
// 1.98 %, max 2.448 mm), but the ADJUDICATED reading did not — the page always excludes wall
// cells (80 of its 143 cells deeper than 0.1 mm) and the wall shadow (13), reading 0.05 % at the
// 0.1 mm floor with a 0.165 mm maximum; the app applied NO exclusions on a job that states no
// edge break, so its adjudicated fraction was the raw 0.147 %. Wall cells are the gate's
// unadjudicable-cell rule, not an edge-break allowance: they are excluded in every goal job, and
// only the rim edge break depends on the job stating one.
//
// v5 (#970): the SHADOW class is no longer unconditional. The page's 13 shadow cells carry no
// CL in this fixture, so the app now ADJUDICATES them (0.3 mm each) rather than excusing them —
// the very class that hid E's 3.49 mm tray gouge. The second case pins the stamp-artefact
// excuse: with the deepest cutter's CL stated clear of the wall, the shadow cells are excused
// again, exactly as v4 excused them.
//
// This fixture reproduces that card's numbers on a 97,600-cell goal (the top clamp's own cell
// count, to the cell): 143 cut cells, 80 on the wall (the deepest 2.448 mm), 13 in the shadow,
// 50 adjudicated (deepest 0.165 mm) — with NO edgeBreak option.

import { describe, expect, it } from 'vitest';

import { checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

const PITCH = 0.1;
const NX = 320; // 32 mm
const NY = 305; // 30.5 mm — 97,600 cells, the top-clamp card's count
const N = NX * NY;
const WALL_X = 15; // the design step: x < 15 at z 0, x >= 15 at z -2
const SHADOW_R = 3;

/** The goal: a 2 mm step at x = 15 (its wall cells are the two columns facing the step). */
function goal(): GoalHeightfield {
  const z = new Float32Array(N);
  const covered = new Uint8Array(N).fill(1);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) z[j * NX + i] = i * PITCH < WALL_X ? 0 : -2;
  }
  return {
    nx: NX,
    ny: NY,
    x0: 0,
    y0: 0,
    pitch: PITCH,
    topZ: 0,
    minZ: -2,
    z,
    covered,
    coveredCount: N,
    resolutionNote: 'test',
  };
}

/** Where the cutter went below the goal: [cell, depth]. 80 wall + 13 shadow + 50 adjudicated. */
const CUTS = new Map<number, number>();
for (let k = 0; k < 80; k++) CUTS.set((40 + k) * NX + 149, k === 0 ? 2.448 : 2.0); // the wall column left of the step
for (let k = 0; k < 13; k++) CUTS.set(40 * NX + 151 + k, 0.3); // just past the step, inside the 3 mm shadow
for (let k = 0; k < 50; k++) CUTS.set(100 * NX + 250 + k, k === 0 ? 0.165 : 0.12); // clear of wall and shadow

const GOAL = goal();
const top = (x: number, y: number): number | null => {
  const i = Math.round((x - GOAL.x0) / PITCH);
  const j = Math.round((y - GOAL.y0) / PITCH);
  if (i < 0 || j < 0 || i >= NX || j >= NY) return null;
  return (GOAL.z[j * NX + i] as number) - (CUTS.get(j * NX + i) ?? 0);
};

describe('#964 the gate’s unadjudicable cells, with no edge break stated', () => {
  it('excludes wall cells and the wall shadow anyway: the adjudicated reading is the page’s', () => {
    const r = checkGoalCutInto(GOAL, top, { wallShadowRadiusMm: SHADOW_R });
    // The RAW reading, exactly as the page states it.
    expect(r.cutIntoFraction).toBeCloseTo(143 / N, 12);
    expect(r.cutIntoFraction * 100).toBeCloseTo(0.1465, 3);
    expect(r.maxCutIntoMm).toBeCloseTo(2.448, 6);
    expect(r.maxCutIntoAt).toEqual({ x: 14.9, y: 4 });
    // The exclusions, in a job that states no edge break. v5: wall cells stay excluded; the 13
    // shadow cells state no CL, so they are ADJUDICATED with the other 50.
    expect(r.edgeBreakFraction).toBe(0);
    expect(r.wallNotScoredFraction).toBeCloseTo(80 / N, 12);
    expect(r.shadowNotScoredFraction).toBe(0);
    // The ADJUDICATED reading: 63 cells — the 50 clear ones (deepest 0.165 mm at (25, 10), still
    // the maximum) and the 13 shadow cells (0.3 mm each).
    expect(r.adjudicatedFraction).toBeCloseTo(63 / N, 12);
    expect(r.adjudicatedFraction * 100).toBeCloseTo(0.0645, 3);
    expect(r.adjudicatedMaxMm).toBeCloseTo(0.3, 6);
    expect(r.adjudicatedMaxAt!.x).toBeCloseTo(15.1, 9); // the first shadow cell (v5)
    expect(r.adjudicatedMaxAt!.y).toBeCloseTo(4, 9);
    // And the gate judges on that reading, not on the raw one.
    expect(r.ok).toBe(false);
    expect(r.sentence).toContain('not counted');
  });

  it('v5 — the shadow class is excused on the stamp artefact, not on the cell’s position', () => {
    // The deepest cutter's CL stated 3 mm clear of the wall (x = 18 against a wall at x = 15):
    // the disc's rim covered the 13 cells, so they are the stamp artefact E's rule excuses.
    const r = checkGoalCutInto(GOAL, top, { wallShadowRadiusMm: SHADOW_R, clAt: () => ({ x: 18, y: 4 }) });
    expect(r.shadowNotScoredFraction).toBeCloseTo(13 / N, 12);
    expect(r.adjudicatedFraction).toBeCloseTo(50 / N, 12);
    expect(r.adjudicatedMaxMm).toBeCloseTo(0.165, 6);
    // A CL at the wall's base excuses nothing: the same 13 cells are adjudicated at 0.3 mm.
    const atWall = checkGoalCutInto(GOAL, top, { wallShadowRadiusMm: SHADOW_R, clAt: () => ({ x: 15, y: 4 }) });
    expect(atWall.shadowNotScoredFraction).toBe(0);
    expect(atWall.adjudicatedFraction).toBeCloseTo(63 / N, 12);
  });

  it('a clean program still passes: nothing adjudicated, coverage above the line', () => {
    const r = checkGoalCutInto(GOAL, (x, y) => {
      const i = Math.round(x / PITCH);
      const j = Math.round(y / PITCH);
      return GOAL.z[j * NX + i]!;
    }, { wallShadowRadiusMm: SHADOW_R });
    expect(r.adjudicatedFraction).toBe(0);
    expect(r.adjudicatedMaxMm).toBe(0);
    expect(r.wallNotScoredFraction).toBe(0); // no cell is cut, so nothing is excluded
    expect(r.ok).toBe(true);
  });
});
