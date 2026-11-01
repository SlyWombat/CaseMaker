// #607 — the 4th-axis reference tap's geometry, against a bench-shaped chuck: a 40 mm radius body
// whose centre (the axis) is Y −180, Z −50. The solve uses ONE ball-centre chord and the crown's
// ball centre — the ball centres lie on a circle R + r about the same axis, so the probe's radius
// cancels out of the axis position — and the second chord is a CHECK whose residual is information.

import { describe, expect, it } from 'vitest';
import {
  chordResidualMm,
  planRotaryTrial,
  solveRotaryCircle,
  ROTARY_CHORD_TOLERANCE_MM,
} from '@/engine/cnc/registration/rotaryTap';

const AXIS_Z = -50;
const AXIS_Y = -180;
const R = 40;
const BED_CLEARANCE_Z = -56; // the bed's surface plus the probe body's clearance, machine Z

/** The face width at machine Z for a chuck of `radius` (the chord the side touches measure). */
function widthAt(z: number, radius = R): number {
  const dz = z - AXIS_Z;
  return 2 * Math.sqrt(Math.max(0, radius * radius - dz * dz));
}

describe('#607 planRotaryTrial', () => {
  it('puts the trial chord half a radius below the crown, inside the sound band, above the bed', () => {
    const plan = planRotaryTrial({ axisZ: AXIS_Z, radiusMm: R }, BED_CLEARANCE_Z);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.depthMm).toBeCloseTo(0.5 * R, 6);
    expect(plan.z1).toBeCloseTo(AXIS_Z + 0.5 * R, 6); // crown − 0.5R
    expect(plan.z1).toBeGreaterThanOrEqual(BED_CLEARANCE_Z);
    expect(plan.z2).not.toBe(plan.z1);
  });

  it('refuses by name only when the whole sound band is under the bed/headstock clearance', () => {
    // The shallowest sound height is crown − 0.3R = −22; a bed clearance ABOVE it leaves nothing.
    const plan = planRotaryTrial({ axisZ: AXIS_Z, radiusMm: R }, AXIS_Z + 30);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('probe body beside the chuck cannot clear the bed');
  });
});

describe('#607 the one-chord-and-crown solve', () => {
  it('recovers the bench chuck: R 40, axis Z −50, Y −180', () => {
    const z1 = AXIS_Z + 0.5 * R;
    const chord = { y: AXIS_Y, widthMm: widthAt(z1), zMachine: z1 };
    const solved = solveRotaryCircle(chord, AXIS_Z + R);
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.circle.radiusMm).toBeCloseTo(R, 6);
    expect(solved.circle.axisZ).toBeCloseTo(AXIS_Z, 6);
    expect(solved.circle.axisY).toBeCloseTo(AXIS_Y, 6);
    expect(solved.circle.depthMm).toBeCloseTo(0.5 * R, 6);
  });

  it('measures an OFF-NOMINAL chuck rather than trusting the record', () => {
    const trueR = 41;
    const z1 = AXIS_Z + 20;
    const solved = solveRotaryCircle({ y: AXIS_Y, widthMm: widthAt(z1, trueR), zMachine: z1 }, AXIS_Z + trueR);
    expect(solved.ok).toBe(true);
    if (solved.ok) expect(solved.circle.radiusMm).toBeCloseTo(trueR, 6);
  });

  it('refuses a crown at or below the chord, and a chord with no span', () => {
    expect(solveRotaryCircle({ y: 0, widthMm: 20, zMachine: -10 }, -10).ok).toBe(false);
    expect(solveRotaryCircle({ y: 0, widthMm: 0, zMachine: -30 }, -10).ok).toBe(false);
  });
});

describe('#607 the check chord', () => {
  const z1 = AXIS_Z + 20;
  const solved = solveRotaryCircle({ y: AXIS_Y, widthMm: widthAt(z1), zMachine: z1 }, AXIS_Z + R);
  if (!solved.ok) throw new Error(solved.reason);
  const circle = solved.circle;

  it('a chord on the fitted circle has no residual', () => {
    const z2 = AXIS_Z + 5;
    expect(chordResidualMm({ y: AXIS_Y, widthMm: widthAt(z2), zMachine: z2 }, circle)).toBeLessThan(0.001);
  });

  it('a chord off the fitted circle reports its residual, and the bar is 0.05 mm', () => {
    const z2 = AXIS_Z + 5;
    const residual = chordResidualMm({ y: AXIS_Y, widthMm: widthAt(z2) + 0.1, zMachine: z2 }, circle);
    expect(residual).toBeCloseTo(0.1, 2);
    expect(residual).toBeGreaterThan(ROTARY_CHORD_TOLERANCE_MM);
  });
});
