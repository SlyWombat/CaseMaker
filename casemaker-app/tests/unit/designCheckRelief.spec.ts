/**
 * #1092 / gate v8 — THE EXCUSE IS A PROOF BOUNDED BY THE GOAL'S RELIEF (red-first).
 *
 * 0f's ruling (2026-11-08, comment 6727544988): a wall, border or shadow cell is excused only when
 * its depth is no more than the goal's own local relief at the cell — max − min of the covered
 * goal top within the shadow radius r (a border cell counts the stock top as a high side) — plus
 * the straddling slack. The exclusions exist for heightfield artefacts, which are bounded by the
 * height of the wall the cutter works beside; a cutter buried 20 mm in the body is not one.
 *
 * THE RED-FIRST CASES (this spec fails on the v7 rule — wall/border unconditional, shadow on the
 * v5 CL proof alone — and passes at v8):
 *  1. a 1.36 mm pocket step with a 20 mm-deep trench along it: every class cell of the trench is
 *     counted, so the adjudicated maximum rises from ~0 mm (v7: all excused by class) to ~20 mm;
 *  2. the SAME trench against a 20 mm wall whose stamp's CL point stayed at least r from the wall
 *     (the genuine disc-artefact case): its cells stay excused — the bound is the local relief,
 *     not a constant, so a 20 mm wall may excuse a 20 mm read;
 *  3. the same trench with the CL point INSIDE the trench (less than r from the wall): the v5
 *     proof fails and the cells are counted — the relief is a ceiling, never a substitute for the
 *     proof.
 */
import { describe, expect, it } from 'vitest';

import { checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

const PITCH = 0.5;
const R_MM = 3; // the largest cutter's radius → the shadow radius r

/** A covered grid at `pitch`, z from `zAt`; `cutAt` returns the swept top (null = no cut read). */
function fixture(
  nx: number,
  ny: number,
  zAt: (i: number, j: number) => number,
  sweptAt: (i: number, j: number, z: number) => number,
): { goal: GoalHeightfield; reader: (x: number, y: number) => number | null } {
  const z = new Float32Array(nx * ny);
  const covered = new Uint8Array(nx * ny);
  let minZ = Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      z[k] = zAt(i, j);
      covered[k] = 1;
      minZ = Math.min(minZ, z[k]!);
    }
  }
  const goal: GoalHeightfield = {
    nx,
    ny,
    x0: 0,
    y0: 0,
    pitch: PITCH,
    topZ: 0,
    minZ,
    z,
    covered,
    coveredCount: nx * ny,
    resolutionNote: 'designCheckRelief1092 fixture',
  };
  const reader = (x: number, y: number): number | null => {
    const i = Math.round((x - goal.x0) / PITCH);
    const j = Math.round((y - goal.y0) / PITCH);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
    const k = j * nx + i;
    return sweptAt(i, j, goal.z[k]!);
  };
  return { goal, reader };
}

// The wall sits between i = 19 (land) and i = 20 (floor); the trench starts at `TRENCH_FROM`.
const TRENCH_FROM = 20;
const TRENCH_TO = 28;

describe('#1092 (gate v8) — the excuse is bounded by the goal’s own relief', () => {
  it('counts a 20 mm trench along a 1.36 mm step — the class no longer hides it', () => {
    const { goal, reader } = fixture(
      40,
      20,
      (i) => (i < 20 ? 0 : -1.36),
      (i, j, z) => (i >= TRENCH_FROM && i <= TRENCH_TO && j >= 2 && j <= 17 ? z - 20 : z),
    );
    const report = checkGoalCutInto(goal, reader, { wallShadowRadiusMm: R_MM });
    // v7 read ~0 mm here (the wall class excused the trench's first cell and the shadow class the
    // rest); v8 counts the wall cell at the trench's edge and the shadow cells beyond it.
    expect(report.adjudicatedMaxMm).toBeGreaterThan(19.9);
    expect(report.maxCutIntoMm).toBeGreaterThan(19.9);
    expect(report.wallOverReliefCells).toBeGreaterThan(0);
    expect(report.sentence).toContain('counted instead');
  });

  it('keeps the same trench excused against a 20 mm wall when the CL stayed r from it (disc artefact)', () => {
    const { goal, reader } = fixture(
      40,
      20,
      (i) => (i < 20 ? 0 : -20),
      (i, j, z) => (i >= TRENCH_FROM + 1 && i <= TRENCH_FROM + 4 && j >= 2 && j <= 17 ? z - 20 : z),
    );
    // The CL point sits r + one cell beyond the wall: the v5 proof says the cell is the disc's rim.
    const clAt = (): { x: number; y: number } => ({ x: 20 * PITCH + R_MM + PITCH, y: 5 });
    const report = checkGoalCutInto(goal, reader, { wallShadowRadiusMm: R_MM, clAt });
    expect(report.adjudicatedMaxMm).toBeCloseTo(0, 6);
    expect(report.shadowOverReliefCells).toBe(0);
  });

  it('counts a silhouette cell whose CL is inside with no step to straddle — the CL test is kept', () => {
    // #1092 (0f's follow-up) — a failed silhouette CL test FALLS THROUGH to the v6 straddling
    // proof (an open pocket reaching the rim has its CL inside and is excused there). With NO
    // step to straddle the fall-through cannot excuse it either: the cell is COUNTED.
    const nx = 20;
    const ny = 10;
    const z = new Float32Array(nx * ny);
    const covered = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) covered[j * nx + i] = i < 10 ? 1 : 0; // covered half: the part
    }
    const goal: GoalHeightfield = {
      nx,
      ny,
      x0: 0,
      y0: 0,
      pitch: PITCH,
      topZ: 0,
      minZ: 0,
      z,
      covered,
      coveredCount: 10 * ny,
      stockThicknessMm: 5,
      resolutionNote: 'designCheckRelief1092 silhouette fixture',
    };
    const top = (x: number, y: number): number | null => {
      const i = Math.round(x / PITCH);
      const j = Math.round(y / PITCH);
      if (i < 0 || j < 0 || i >= nx || j >= ny || covered[j * nx + i] !== 1) return null;
      return i === 9 && j === 5 ? -0.5 : 0;
    };
    // The CL one millimetre INSIDE the part (cell (7, 5)), not on the uncovered side.
    const clAt = (): { x: number; y: number } => ({ x: 3.75, y: 2.5 });
    const report = checkGoalCutInto(goal, top, { wallShadowRadiusMm: 1.5, stockThicknessMm: 5, clAt });
    expect(report.silhouetteExcusedCells).toBe(0);
    expect(Math.round(report.adjudicatedFraction * report.goalCells)).toBe(1);
    expect(report.adjudicatedMaxMm).toBeCloseTo(0.5, 6);
  });

  it('counts the same trench when the CL point is inside it — the relief is a ceiling, not a proof', () => {
    const { goal, reader } = fixture(
      40,
      20,
      (i) => (i < 20 ? 0 : -20),
      (i, j, z) => (i >= TRENCH_FROM + 1 && i <= TRENCH_FROM + 4 && j >= 2 && j <= 17 ? z - 20 : z),
    );
    const clAt = (): { x: number; y: number } => ({ x: 21 * PITCH, y: 5 });
    const report = checkGoalCutInto(goal, reader, { wallShadowRadiusMm: R_MM, clAt });
    // The v5 proof fails here (the CL sits inside the trench), so the relief ceiling — which the
    // 20 mm wall would satisfy — is never reached: the cells are counted, not excused.
    expect(report.adjudicatedMaxMm).toBeGreaterThan(19.9);
  });
});
