/**
 * #1095 — THE ROTARY GOAL CHECK'S VERDICT. The #1083 report computed coverage, the pass line and
 * adjudicated cut-into, but returned `ok: true` unconditionally; the sentence could state a failure
 * while the report passed. The verdict now follows the flat check: zero adjudicated cut-into at the
 * floor AND the goal's top surface at or above the pass line.
 *
 * Red at the base: every `ok` below on a failing report is `true`.
 */
import { describe, expect, it } from 'vitest';

import type { GoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import type { ColumnGrid } from '@/workers/geometry/columnEngine';
import { checkGoalCutIntoRotary } from '@/workers/sim/goalCheckRotary';

const R = 10;
const PITCH = 0.2;
const NX = 50;
const NY = 315;
const DV = 360 / NY;
const GROOVE = [60, 90] as const;
const DEPTH = 2;

/** The goal: the rod's surface, a 2 mm groove over rows [60, 90). */
function goal(): GoalRadialField {
  const z = new Float32Array(NX * NY);
  for (let j = GROOVE[0]; j < GROOVE[1]; j++) for (let i = 0; i < NX; i++) z[j * NX + i] = -DEPTH;
  return {
    nx: NX,
    ny: NY,
    x0: 0,
    y0: 0,
    pitch: PITCH,
    radius: R,
    minRadius: R - DEPTH,
    maxRadius: R,
    z,
    covered: new Uint8Array(NX * NY).fill(1),
    coveredCount: NX * NY,
    resolutionNote: 'synthetic',
  };
}

const designAt = (_i: number, j: number): number => R + (j >= GROOVE[0] && j < GROOVE[1] ? -DEPTH : 0);

function grid(set: (i: number, j: number) => number): ColumnGrid {
  const h = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) h[j * NX + i] = set(i, j);
  return { kind: 'rotary', nu: NX, nv: NY, u0: 0, du: PITCH, v0: 0, dv: DV, initial: R, base: 0, h };
}

describe('#1095 the rotary goal check judges its own numbers', () => {
  it('a clean exact cut passes', () => {
    const report = checkGoalCutIntoRotary(goal(), grid((i, j) => designAt(i, j)), null);
    expect(report.cutIntoFraction).toBe(0);
    expect(report.leftoverFractions[0]).toBeLessThanOrEqual(0.01);
    expect(report.ok).toBe(true);
  });

  it('an over-deep cut fails, even though the column read used to pass it', () => {
    const report = checkGoalCutIntoRotary(
      goal(),
      grid((i, j) => (i >= 10 && i <= 12 && j >= 69 && j <= 71 ? designAt(i, j) - 0.5 : designAt(i, j))),
      null,
    );
    expect(report.cutIntoFraction).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  it('a clean cut whose top-surface coverage is below the pass line fails', () => {
    // The groove stands at the stock's radius: no cut-into, but 30 of 315 rows (≈ 9.5 %) are more
    // than 0.1 mm above the goal — under the 95 % pass line.
    const report = checkGoalCutIntoRotary(
      goal(),
      grid((_i, j) => (j >= GROOVE[0] && j < GROOVE[1] ? R : designAt(_i, j))),
      null,
    );
    expect(report.cutIntoFraction).toBe(0);
    expect(1 - (report.leftoverFractions[0] ?? 1)).toBeLessThan(report.passCoverage);
    expect(report.ok).toBe(false);
  });
});
