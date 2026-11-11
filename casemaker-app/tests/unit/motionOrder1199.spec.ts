// #1199 — THE SAFE-Z INVARIANT for every probing session: XY is moved ONLY at the machine's
// clearance (or above), and the head descends ONLY at the point to be probed.
//
// Red-first evidence: the bench's own seat sequence (build c8fa03a6, 2026-11-10, which bent
// fx-probe-1's shaft) is `G53 G0 Z-81.25` AT HOME then `G53 G0 X-175 Y-35` — a 177 mm traverse
// 7 mm above the board. The guard must refuse its second line; the corrected order must pass.
import { describe, expect, it } from 'vitest';
import { motionOrderGuard } from '@/engine/cnc/registration/motionOrder';

const CLEARANCE = -3;
const SEAT_FROM = -81.25; // band.max (−84.25) + parkAboveSurfaceMm (3)
const PRB_SEAT = 'ok\n[PRB:-175.000,-35.000,-88.083:1]';

describe('#1199 — the shared motion-order guard', () => {
  it('REFUSES the c8fa03a6 seat sequence: a 177 mm XY traverse at machine Z −81.25', () => {
    const guard = motionOrderGuard(CLEARANCE);
    expect(guard.observe('$H')).toBeNull();
    expect(guard.observe(`G53 G0 Z${SEAT_FROM}`)).toBeNull();
    const problem = guard.observe('G53 G0 X-175 Y-35');
    expect(problem).not.toBeNull();
    expect(problem).toContain('refusing to move X/Y from machine Z -81.25');
    expect(problem).toContain('-3');
  });

  it('accepts the corrected order: traverse at the clearance, descend AT the seat, probe, lift', () => {
    const guard = motionOrderGuard(CLEARANCE);
    for (const line of [
      '$H',
      `G53 G0 Z${CLEARANCE}`,
      'G53 G0 X-175 Y-35',
      `G53 G0 Z${SEAT_FROM}`,
      'G91',
      'G38.3 Z-11 F150',
      'G90',
      `G53 G0 Z${CLEARANCE}`,
      'G53 G0 X-175 Y-35',
    ]) {
      expect(guard.observe(line, line.startsWith('G38.3') ? PRB_SEAT : 'ok'), line).toBeNull();
    }
  });

  it('refuses an XY move after a probe that left the head at the trigger point', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    guard.observe(`G53 G0 Z${CLEARANCE}`);
    guard.observe('G53 G0 X-175 Y-35');
    guard.observe(`G53 G0 Z${SEAT_FROM}`);
    guard.observe('G91');
    guard.observe('G38.3 Z-11 F150', PRB_SEAT);
    // The head is at the trigger, −88.083. An XY rapid from here is the same class of hazard.
    const problem = guard.observe('G0 X-100 Y-35');
    expect(problem).toContain('refusing to move X/Y from machine Z -88.083');
  });

  it('refuses an XY move when the Z is unknown (a relative Z move hides it)', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    guard.observe('G91');
    guard.observe('G0 Z-5');
    expect(guard.observe('G0 X-100')).toContain('the head is at an unknown Z');
  });

  it('leaves probe moves, lifts and non-motion lines alone', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    for (const line of ['?', 'M119', 'M491', 'G10 L20 P0 A0', 'G54', 'G92.1', 'G38.5 X3 F100', 'G0 Z3']) {
      expect(guard.observe(line), line).toBeNull();
    }
  });

  it('reads a G53 G0 Z at or above the clearance as the traverse height', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    guard.observe('G53 G0 Z0');
    expect(guard.observe('G53 G0 X10 Y10')).toBeNull();
  });
});
