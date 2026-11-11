/**
 * #1059 — THE FACE-ANGLE STEP'S PLAN AND SOLVER (the maintainer's 5(a″), the vendor's procedure).
 *
 * A square bar in the 4th axis is levelled with two probe touches on the top face at ±d either
 * side of the axis: `θ = atan((Z+ − Z−) / 2d)`, A turns by −θ, the touches repeat, and the levelled
 * position becomes the A work zero. The plan owns the placement and the three safety rules the
 * Manager added (2026-11-08): every A turn is lifted clear of the ENVELOPE, a θ past the shop's
 * limit is refused not turned, and the ball keeps clear of BOTH keep-outs (the jaws and the
 * tailstock band).
 *
 * RED at 1059-cylinder-stock before this module existed (the import itself fails).
 */
import { describe, expect, it } from 'vitest';

import {
  FACE_ANGLE_BALL_CLEARANCE_MM,
  FACE_ANGLE_LEVEL_BAND_MM,
  faceAngleLimitProblem,
  planFaceAngle,
  solveFaceAngle,
  type FaceAngleInputs,
} from '@/engine/cnc/registration/faceAngle';

const AXIS = { axisY: -125.06, axisZ: -37.71 };
const SQUARE = { kind: 'rect' as const, width: 44.5, height: 44.5 };
const ENVELOPE_R = Math.hypot(44.5, 44.5) / 2;

const inputs = (over: Partial<FaceAngleInputs> = {}): FaceAngleInputs => ({
  axis: AXIS,
  section: SQUARE,
  jawFaceX: -150,
  freeEndMm: 85,
  probeRadiusMm: 0.875,
  clearanceAboveStockMm: 5,
  machineClearanceZ: -3,
  parkAboveSurfaceMm: 3,
  bandAllowanceMm: 1,
  softLimits: { xMin: -207, yMin: -206, zMin: -102 },
  maxDeg: 10,
  ...over,
});

describe('#1059 the face-angle plan', () => {
  it('places two touches 15 mm either side of the axis, at the free span’s middle', () => {
    const plan = planFaceAngle(inputs());
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.d).toBe(15);
    expect(plan.x).toBeCloseTo(-106, 3);
    expect(plan.yPlus).toBeCloseTo(-110.06, 3);
    expect(plan.yMinus).toBeCloseTo(-140.06, 3);
    // The face's expected top is the axis plus the section's half-height; the touch caps below it.
    expect(plan.faceTopZ).toBeCloseTo(-15.46, 3);
    expect(plan.bandFloorZ).toBeCloseTo(-16.46, 3);
    expect(plan.parkZ).toBeCloseTo(-12.46, 3);
  });

  it('SAFETY 1 — every A turn is lifted clear of the ENVELOPE, not of the face', () => {
    const plan = planFaceAngle(inputs());
    if (!plan.ok) throw new Error(plan.reason);
    // The corner sweeps past the face's height as the stock turns, so the lift is the envelope
    // radius plus the CAM's clearance — measured from the AXIS, not from the park above the face.
    expect(plan.envelopeRadiusMm).toBeCloseTo(ENVELOPE_R, 3);
    expect(plan.turnClearanceZ).toBeCloseTo(-37.71 + ENVELOPE_R + 5, 3);
    expect(plan.turnClearanceZ).toBeGreaterThan(plan.parkZ);
    // The machine's own clearance is a floor when it is the higher of the two.
    const higher = planFaceAngle(inputs({ machineClearanceZ: 2 }));
    if (!higher.ok) throw new Error(higher.reason);
    expect(higher.turnClearanceZ).toBe(2);
  });

  it('SAFETY 3 — the ball keeps its clearance from the jaws AND from the tailstock band', () => {
    const plan = planFaceAngle(inputs());
    if (!plan.ok) throw new Error(plan.reason);
    const ballToJaws = plan.x - 0.875 - (-150);
    const ballToFreeEnd = -150 + 85 - (plan.x + 0.875);
    expect(ballToJaws).toBeGreaterThanOrEqual(FACE_ANGLE_BALL_CLEARANCE_MM);
    expect(ballToFreeEnd).toBeGreaterThanOrEqual(FACE_ANGLE_BALL_CLEARANCE_MM);
    // A stick-out that leaves no room between the two keep-outs is refused by name.
    const short = planFaceAngle(inputs({ freeEndMm: 12 }));
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.reason).toContain('no room to touch the face');
      expect(short.reason).toContain('tailstock');
    }
  });

  it('SAFETY 2 — the solver is atan((Z+ − Z−)/2d), and a reading past the limit is refused, not turned', () => {
    expect(solveFaceAngle(-15.0, -15.5, 15)).toBeCloseTo((Math.atan2(0.5, 30) * 180) / Math.PI, 9);
    expect(solveFaceAngle(-15.46, -15.46, 15)).toBe(0);
    // 0.95° is inside a 10° limit; 12° is not, and the sentence says why it is not a turn.
    expect(faceAngleLimitProblem(-15.0, -15.5, 15, 10)).toBeNull();
    const over = faceAngleLimitProblem(-15.46 + 15 * Math.tan((12 * Math.PI) / 180), -15.46 - 15 * Math.tan((12 * Math.PI) / 180), 15, 10);
    expect(over).toContain('12° of tilt');
    expect(over).toContain('wrong touch or a wrong mounting, not a turn');
  });

  it('refuses round stock, an unmeasured axis, a stated machine, and a face too narrow for two touches', () => {
    const round = planFaceAngle(inputs({ section: { kind: 'round', diameter: 44.5 } }));
    expect(round.ok).toBe(false);
    if (!round.ok) expect(round.reason).toContain('no face to level');
    const noAxis = planFaceAngle(inputs({ axis: null }));
    expect(noAxis.ok).toBe(false);
    if (!noAxis.ok) expect(noAxis.reason).toContain('measure the axis first');
    const stated = planFaceAngle(inputs({ machineClearanceZ: null }));
    expect(stated.ok).toBe(false);
    const narrow = planFaceAngle(inputs({ section: { kind: 'rect', width: 6, height: 44.5 } }));
    expect(narrow.ok).toBe(false);
    if (!narrow.ok) expect(narrow.reason).toContain('at least 2 mm is needed');
  });

  it('checks the planned moves against the machine’s soft limits', () => {
    const x = planFaceAngle(inputs({ softLimits: { xMin: -100, yMin: -206, zMin: -102 } }));
    expect(x.ok).toBe(false);
    if (!x.ok) expect(x.reason).toContain('X soft limit');
    const z = planFaceAngle(inputs({ softLimits: { xMin: -207, yMin: -206, zMin: -10 } }));
    expect(z.ok).toBe(false);
    if (!z.ok) expect(z.reason).toContain('Z soft limit');
    const y = planFaceAngle(inputs({ softLimits: { xMin: -207, yMin: -130, zMin: -102 } }));
    expect(y.ok).toBe(false);
    if (!y.ok) expect(y.reason).toContain('Y soft limit');
  });

  it('states the numbers it kept, in the operator’s words', () => {
    const plan = planFaceAngle(inputs());
    if (!plan.ok) throw new Error(plan.reason);
    const text = plan.notes.join('\n');
    expect(text).toContain('at 15 mm either side of the axis line');
    expect(text).toContain('3 mm clear of the jaws');
    expect(text).toContain('every A word is sent from machine Z');
    expect(text).toContain('10°');
    expect(FACE_ANGLE_LEVEL_BAND_MM).toBe(0.02);
  });

  it('#1211 field 7 — a wider JAW BAND moves the touch X by half the extra band (the tail side stays)', () => {
    const fallback = planFaceAngle(inputs());
    const wider = planFaceAngle(inputs({ jawKeepOutMm: 10 }));
    if (!fallback.ok) throw new Error(fallback.reason);
    if (!wider.ok) throw new Error(wider.reason);
    expect(fallback.jawKeepOutMm).toBe(3); // the registry's labelled fallback
    expect(wider.jawKeepOutMm).toBe(10);
    // The jaw-side clearance moves by the extra band; the tail side does not, so the touch X (the
    // span's midpoint) moves by half of it.
    expect(wider.x - fallback.x).toBeCloseTo(7 / 2, 6);
    expect(wider.notes.join('\n')).toContain('10 mm keep-out');
  });

  it('#1211 field 7 — a wider BALL CLEARANCE moves both sides together: the touch X does not move', () => {
    const fallback = planFaceAngle(inputs());
    const wider = planFaceAngle(inputs({ ballClearanceMm: 6 }));
    if (!fallback.ok) throw new Error(fallback.reason);
    if (!wider.ok) throw new Error(wider.reason);
    expect(fallback.ballClearanceMm).toBe(3); // the registry's labelled fallback
    expect(wider.ballClearanceMm).toBe(6);
    // The clearance is kept at BOTH ends: the jaw side moves outward by the extra 3 mm and the
    // tail side moves the same way (it keeps the clearance from the free end), so the touch X —
    // the span's midpoint — does not move.
    expect(wider.x).toBeCloseTo(fallback.x, 6);
    expect(wider.notes.join('\n')).toContain('6 mm clear of the jaws');
  });

  it('#1211 field 7 — THE COMBINED RULE (the authority): the jaw side adds the keep-out AND the clearance; the tail side only the clearance', () => {
    const need = (p: ReturnType<typeof planFaceAngle>) => {
      if (!p.ok) throw new Error(p.reason);
      return p;
    };
    const plain = need(planFaceAngle(inputs()));
    const jaw = need(planFaceAngle(inputs({ jawKeepOutMm: 10 })));
    const ball = need(planFaceAngle(inputs({ ballClearanceMm: 6 })));
    const both = need(planFaceAngle(inputs({ jawKeepOutMm: 10, ballClearanceMm: 6 })));
    // The geometry the plan states and used:
    //   jaw side  = jaw face + keep-out + ball clearance + probe radius
    //   tail side = jaw face + free end - ball clearance - probe radius
    //   the touch X is the midpoint of the two.
    const jawSide = (p: typeof plain): number => p.jawFaceX + p.jawKeepOutMm + p.ballClearanceMm + p.probeRadiusMm;
    const tailSide = (p: typeof plain): number => p.jawFaceX + p.freeEndMm - p.ballClearanceMm - p.probeRadiusMm;
    const mid = (p: typeof plain): number => (jawSide(p) + tailSide(p)) / 2;
    for (const p of [plain, jaw, ball, both]) {
      expect(p.x).toBeCloseTo(mid(p), 6);
      expect(p.notes.join('\n')).toContain(`${p.jawKeepOutMm} mm keep-out`);
      expect(p.notes.join('\n')).toContain(`${p.ballClearanceMm} mm clear of the jaws`);
    }
    // The two derivatives, stated together: the jaw band moves only the jaw side (half at the
    // midpoint); the ball clearance moves both sides (none at the midpoint); both compose.
    expect(jaw.x - plain.x).toBeCloseTo(7 / 2, 6);
    expect(ball.x - plain.x).toBeCloseTo(0, 6);
    expect(both.x - plain.x).toBeCloseTo(7 / 2, 6);
    expect(jawSide(both) - jawSide(plain)).toBeCloseTo(7 + 3, 6);
    expect(tailSide(both) - tailSide(plain)).toBeCloseTo(-3, 6);
  });
});
