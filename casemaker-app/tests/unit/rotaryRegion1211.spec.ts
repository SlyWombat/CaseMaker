/**
 * #1211 — THE ROTARY'S OWN DESCENT REGION, AND THE GUARD'S TWO ROTARY RULES.
 *
 * The #1199 guard is written for a blank on the bed: a traverse at the machine's clearance, a
 * descent over the stock's footprint. The rotary's job-time probing (`runFaceAngle`,
 * `runCentreFind` on a rod) sends descents with NO region at all, and the chuck is a full-height
 * obstacle (maintainer 2026-11-07: "You will never move into the chuck area, as that is variable
 * height"). Three rules are pinned here, red-first:
 *
 *  1. FIELD 3 — the chuck keep-out applies to TRAVEL: no XY move, at ANY Z (the clearance
 *     included), may end or pass at machine X inside the jaws' keep-out.
 *  2. FIELD 4 — A TURNS belong to the guard: an A word below the session's turn clearance is
 *     refused by the guard itself, so a routine that forgets its own check still cannot turn.
 *  3. FIELD 2 — ONE rotary job region: descents only over the stock's projection (jaw tips +
 *     keep-out + the probe's radius … the free end less the margin; Y within the section's
 *     envelope, shrunk by the margin), machine XY.
 */
import { describe, expect, it } from 'vitest';

import {
  motionOrderGuard,
  rotaryJobDescentRegion,
  type RotaryJobRegionInput,
} from '@/engine/cnc/registration/motionOrder';
import { ROTARY_JAW_KEEP_OUT_MM } from '@/engine/cnc/rotary/wrap';

const CLEARANCE = -3;
/** The bench's jaw face, machine X — the keep-out's datum (the faceAngle fixtures'). */
const JAW_FACE_X = -150;
const AXIS_Y = -125.06;
const ENVELOPE_R = Math.hypot(44.5 / 2, 44.5 / 2); // a 44.5 mm square's corners
const TURN_CLEARANCE = -1.24;

describe('#1211 field 3 — the chuck keep-out holds on TRAVEL, at any Z', () => {
  const keepOut = { maxMachineX: JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM, what: 'chuck' };

  it('REFUSES a traverse at the machine clearance that ends inside the keep-out', () => {
    const guard = motionOrderGuard(CLEARANCE, { travelKeepOut: keepOut });
    expect(guard.observe('$H')).toBeNull();
    expect(guard.observe(`G53 G0 Z${CLEARANCE}`)).toBeNull();
    const problem = guard.observe(`G53 G0 X${JAW_FACE_X + 1} Y-125`);
    expect(problem, 'a traverse into the chuck must be refused even at the clearance').not.toBeNull();
    expect(problem).toContain('keep-out');
  });

  it('REFUSES a one-axis (modal) X move into the keep-out — the axis alone carries the hazard', () => {
    const guard = motionOrderGuard(CLEARANCE, { travelKeepOut: keepOut });
    guard.observe('$H');
    guard.observe(`G53 G0 Z${CLEARANCE}`);
    expect(guard.observe(`G53 G0 X${JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM + 30}`)).toBeNull();
    const problem = guard.observe(`G53 G0 X${JAW_FACE_X + 1}`);
    expect(problem).not.toBeNull();
    expect(problem).toContain('keep-out');
  });

  it('allows a traverse that stays at or right of the jaw tips + keep-out on every end and path', () => {
    const guard = motionOrderGuard(CLEARANCE, { travelKeepOut: keepOut });
    guard.observe('$H');
    guard.observe(`G53 G0 Z${CLEARANCE}`);
    expect(guard.observe(`G53 G0 X${JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM + 10} Y-125`)).toBeNull();
    expect(guard.observe(`G53 G0 X${JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM + 60} Y-125`)).toBeNull();
  });

  it('REFUSES a work-frame X move while the keep-out is set — the machine X cannot be proven', () => {
    const guard = motionOrderGuard(CLEARANCE, { travelKeepOut: keepOut });
    guard.observe('$H');
    guard.observe(`G53 G0 Z${CLEARANCE}`);
    const problem = guard.observe('G0 X-100.000 Y-125.000');
    expect(problem).not.toBeNull();
    expect(problem).toContain('keep-out');
  });
});

describe('#1211 field 4 — the guard owns the A-turn floor', () => {
  it('REFUSES an A word below the session’s turn clearance (the routine check need not exist)', () => {
    const guard = motionOrderGuard(CLEARANCE, { turnClearanceZ: TURN_CLEARANCE });
    guard.observe('$H');
    guard.observe('G91');
    // The head is at the top of travel after homing; put it between the clearance and the turn
    // floor — legal to traverse, NOT legal to turn.
    guard.observe(`G53 G0 Z${(-2).toFixed(3)}`);
    const problem = guard.observe('G0 A5.000');
    expect(problem, 'an A turn from below the turn clearance must be refused').not.toBeNull();
    expect(problem).toContain('turn');
    expect(problem).toContain('A');
  });

  it('allows the same A word from at or above the turn clearance', () => {
    const guard = motionOrderGuard(CLEARANCE, { turnClearanceZ: TURN_CLEARANCE });
    guard.observe('$H');
    guard.observe('G91');
    guard.observe(`G53 G0 Z${TURN_CLEARANCE.toFixed(3)}`);
    expect(guard.observe('G0 A5.000')).toBeNull();
  });
});

describe('#1211 field 2 — the rotary job descent region', () => {
  const input: RotaryJobRegionInput = {
    jawFaceX: JAW_FACE_X,
    freeEndMm: 85,
    axisY: AXIS_Y,
    envelopeRadiusMm: ENVELOPE_R,
    probeRadiusMm: 0.875,
    marginMm: 2, // the caller's top-touch margin (tip + uncertainty + placement/floor)
    tailstockBandFromMm: null,
  };
  const region = rotaryJobDescentRegion(input);

  it('allows a descent over the rod, inside the keep-out and the free end, within the envelope', () => {
    const x = JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM + input.probeRadiusMm + 30;
    expect(region(true, x, AXIS_Y)).toBe(true);
    expect(region(true, x, AXIS_Y + ENVELOPE_R - input.marginMm - 0.5)).toBe(true);
    expect(region(true, x, AXIS_Y - ENVELOPE_R + input.marginMm + 0.5)).toBe(true);
  });

  it('refuses a descent inside the chuck keep-out, past the free end, or beside the envelope', () => {
    const x = JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM + input.probeRadiusMm + 30;
    // Inside the jaws: jaw tips + keep-out is the floor of the usable span.
    expect(region(true, JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM - 1, AXIS_Y)).toBe(false);
    // Past the free end less the margin.
    expect(region(true, JAW_FACE_X + input.freeEndMm - input.marginMm + 1, AXIS_Y)).toBe(false);
    // Beside the section's swing.
    expect(region(true, x, AXIS_Y + ENVELOPE_R + 1)).toBe(false);
    expect(region(true, x, AXIS_Y - ENVELOPE_R - 1)).toBe(false);
  });

  it('a fitted tailstock band ends the span early', () => {
    const banded = rotaryJobDescentRegion({ ...input, tailstockBandFromMm: 60 });
    const x = JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM + input.probeRadiusMm + 30;
    expect(banded(true, x, AXIS_Y)).toBe(true);
    expect(banded(true, JAW_FACE_X + 61, AXIS_Y)).toBe(false);
  });

  it('a WORK-frame point is refused: the rotary region is machine XY', () => {
    expect(region(false, JAW_FACE_X + 30, AXIS_Y)).toBe(false);
  });
});

describe('#1211 acceptance — the property over rods, sections and probes', () => {
  // The analyst's acceptance bullet: NO job-time rotary routine may descend outside field 2's
  // region, and no XY move at ANY Z may enter the keep-out. Driven through the guard (the layer
  // every routine shares), over the spans the bench actually mounts.
  const SECTIONS = [
    { name: '⌀20 rod', envelope: 10 },
    { name: '⌀44.5 rod', envelope: 44.5 / 2 },
    { name: '44.5 square', envelope: Math.hypot(44.5 / 2, 44.5 / 2) },
    { name: '30 × 20 rect', envelope: Math.hypot(15, 10) },
  ] as const;
  const PROBES = [0.875, 1.5] as const;
  const FREE_ENDS = [40, 85] as const;

  for (const section of SECTIONS) {
    for (const probeRadiusMm of PROBES) {
      for (const freeEndMm of FREE_ENDS) {
        it(`${section.name}, probe r${probeRadiusMm}, ${freeEndMm} mm free: descents only inside, traverses never into the keep-out`, () => {
          const marginMm = 2;
          const input: RotaryJobRegionInput = {
            jawFaceX: JAW_FACE_X,
            freeEndMm,
            axisY: AXIS_Y,
            envelopeRadiusMm: section.envelope,
            probeRadiusMm,
            marginMm,
          };
          const region = rotaryJobDescentRegion(input);
          const guard = motionOrderGuard(CLEARANCE, {
            descentAllowed: region,
            travelKeepOut: { maxMachineX: JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM, what: 'chuck' },
          });
          guard.observe('$H');
          guard.observe(`G53 G0 Z${CLEARANCE}`);

          const xMin = JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM + probeRadiusMm;
          const xMax = JAW_FACE_X + freeEndMm - marginMm;
          const yHalf = section.envelope - marginMm;
          const xMid = (xMin + xMax) / 2;

          /** A traverse to (x, y) then a descent below the clearance: the guard's answer. */
          const descentAt = (x: number, y: number): string | null => {
            const g = motionOrderGuard(CLEARANCE, {
              descentAllowed: region,
              travelKeepOut: { maxMachineX: JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM, what: 'chuck' },
            });
            g.observe('$H');
            g.observe(`G53 G0 Z${CLEARANCE}`);
            const move = g.observe(`G53 G0 X${x.toFixed(3)} Y${y.toFixed(3)}`);
            if (move !== null) return move; // the keep-out refused the traverse itself
            return g.observe('G53 G0 Z-10.000');
          };

          // The span's four inside corners descend; a millimetre outside each refuses.
          for (const [x, y] of [
            [xMin + 1e-3, AXIS_Y],
            [xMax - 1e-3, AXIS_Y],
            [xMid, AXIS_Y + yHalf - 1e-3],
            [xMid, AXIS_Y - yHalf + 1e-3],
          ] as const) {
            expect(descentAt(x, y), `inside (${x}, ${y})`).toBeNull();
          }
          for (const [x, y] of [
            [JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM - 1, AXIS_Y],
            [JAW_FACE_X + freeEndMm + 1, AXIS_Y],
            [xMid, AXIS_Y + section.envelope + 1],
            [xMid, AXIS_Y - section.envelope - 1],
          ] as const) {
            expect(descentAt(x, y), `outside (${x}, ${y})`).not.toBeNull();
          }
          // And no height at all lets a traverse end inside the keep-out.
          for (const z of [CLEARANCE, 0, 50]) {
            const g = motionOrderGuard(CLEARANCE, { travelKeepOut: { maxMachineX: JAW_FACE_X + ROTARY_JAW_KEEP_OUT_MM, what: 'chuck' } });
            g.observe('$H');
            g.observe(`G53 G0 Z${z.toFixed(3)}`);
            expect(g.observe(`G53 G0 X${JAW_FACE_X}`), `traverse to the jaw face at Z ${z}`).not.toBeNull();
          }
        });
      }
    }
  }
});

// #1211 field 5 (remainder) — A WORK-FRAME LINE IS PROVABLE WHEN THE CALLER STATES THE WORK
// ORIGIN'S MACHINE X. The centre find speaks G54 work coordinates; the chuck keep-out is machine
// X. Without an origin the guard keeps refusing (above); with one it maps the line and applies the
// same rule — inside the keep-out at any Z is refused, outside is allowed.
describe('#1211 field 5 — the keep-out on a work-frame line, with the origin stated', () => {
  const ORIGIN_X = -213.498; // the bench fixture's G54 machine X
  const keepOut = { maxMachineX: -196.5, what: 'chuck', workOriginMachineX: ORIGIN_X };

  it('REFUSES a work X line whose mapped machine X is inside the keep-out', () => {
    const guard = motionOrderGuard(CLEARANCE, { travelKeepOut: keepOut });
    guard.observe('$H');
    guard.observe(`G53 G0 Z${CLEARANCE}`);
    // work 10 -> machine -203.498, inside -196.5
    const problem = guard.observe('G0 X10.000 Y20.000');
    expect(problem).not.toBeNull();
    expect(problem).toContain('keep-out');
  });

  it('ALLOWS a work X line whose mapped machine X is clear of the keep-out', () => {
    const guard = motionOrderGuard(CLEARANCE, { travelKeepOut: keepOut });
    guard.observe('$H');
    guard.observe(`G53 G0 Z${CLEARANCE}`);
    // work 30 -> machine -183.498, clear
    expect(guard.observe('G0 X30.000 Y20.000')).toBeNull();
    // A one-axis modal X move is mapped the same way.
    expect(guard.observe('G0 X31.000')).toBeNull();
    const problem = guard.observe('G0 X10.000');
    expect(problem).not.toBeNull();
    expect(problem).toContain('keep-out');
  });
});
