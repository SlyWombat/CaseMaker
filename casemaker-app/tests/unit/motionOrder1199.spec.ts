// #1199 — THE SAFE-Z INVARIANT for every probing session: XY is moved ONLY at the machine's
// clearance (or above), and the head descends ONLY at the point to be probed.
//
// Red-first evidence: the bench's own seat sequence (build c8fa03a6, 2026-11-10, which bent
// fx-probe-1's shaft) is `G53 G0 Z-81.25` AT HOME then `G53 G0 X-175 Y-35` — a 177 mm traverse
// 7 mm above the board. The guard must refuse its second line; the corrected order must pass.
import { describe, expect, it } from 'vitest';
import { jobDescentRegion, motionOrderGuard, planTravelProblem } from '@/engine/cnc/registration/motionOrder';
import type { EdgeScan, RegistrationPlan } from '@/engine/cnc/registration/plan';

const CLEARANCE = -3;
const SEAT_FROM = -81.25; // band.max (−84.25) + parkAboveSurfaceMm (3)
const PRB_SEAT = 'ok\n[PRB:-175.000,-35.000,-88.083:1]';

describe('#1199 — the shared motion-order guard', () => {
  it('refuses a plan travel height below the machine clearance (the datum is the machine\'s)', () => {
    expect(planTravelProblem(-81.25, -3, 'plan’s travel height')).toContain('below the machine');
    expect(planTravelProblem(-3, -3, 'plan’s travel height')).toBeNull();
    expect(planTravelProblem(-81.25, Number.NaN, 'plan’s travel height')).toContain('not known');
  });

  it('REFUSES the c8fa03a6 seat sequence: a 177 mm XY traverse at machine Z −81.25', () => {
    const guard = motionOrderGuard(CLEARANCE);
    expect(guard.observe('$H')).toBeNull();
    expect(guard.observe(`G53 G0 Z${SEAT_FROM}`)).toBeNull();
    const problem = guard.observe('G53 G0 X-175 Y-35');
    expect(problem).not.toBeNull();
    expect(problem).toContain('refusing to move X/Y/A from machine Z -81.25');
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
    expect(problem).toContain('refusing to move X/Y/A from machine Z -88.083');
  });

  it('refuses an XY move when the Z is unknown (a relative Z move hides it)', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    guard.observe('G91');
    guard.observe('G0 Z-5');
    expect(guard.observe('G0 X-100')).toContain('the head is at an unknown Z');
  });

  // #1199 review (Manager) — DENY BY DEFAULT: classify by the line's WORDS, not a G-prefix shape.
  it('refuses a COMBINED XY+Z move below the clearance: a diagonal is still a traverse', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    const problem = guard.observe('G53 G0 X-175 Y-35 Z-81.25');
    expect(problem).toContain('combined');
    expect(problem).toContain('-81.25');
  });

  it('refuses a combined XY+Z move even from the clearance when its own Z is below it', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    guard.observe('G53 G0 Z-3');
    expect(guard.observe('G0 X10 Y10 Z-40')).toContain('combined');
  });

  it('accepts a combined XY+Z at or above the clearance', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    expect(guard.observe('G53 G0 X10 Y10 Z0')).toBeNull();
  });

  it('refuses G00/G01 spellings and modal continuations below the clearance', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    guard.observe('G53 G0 Z-81.25');
    expect(guard.observe('G00 X-10 Y-10')).toContain('refusing to move X/Y/A');
    expect(guard.observe('G01 X-10 Y-10')).toContain('refusing to move X/Y/A');
    expect(guard.observe('X-10 Y-10')).toContain('refusing to move X/Y/A');
  });

  it('refuses an A turn below the clearance, and allows it from the clearance', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    guard.observe('G53 G0 Z-40');
    expect(guard.observe('G0 A90')).toContain('refusing to move X/Y/A from machine Z -40');
    guard.observe('G53 G0 Z0');
    expect(guard.observe('G91')).toBeNull();
    expect(guard.observe('G0 A90')).toBeNull();
  });

  it('refuses a motion line it cannot classify (deny by default)', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    expect(guard.observe('G2 X10 Y10 I5 J0')).toContain('unrecognised');
  });

  it('treats G10/G92 offset writes as non-motion (no Z state, no refusal)', () => {
    const guard = motionOrderGuard(CLEARANCE);
    guard.observe('$H');
    guard.observe('G53 G0 Z-3');
    expect(guard.observe('G10 L20 P0 A0')).toBeNull();
    expect(guard.observe('G10 L2 P1 X-1 Y-2 Z-3')).toBeNull();
    // The offsets did not consume the Z state: an XY move at the clearance still passes.
    expect(guard.observe('G0 X-10 Y-10')).toBeNull();
  });

  it('#1200 — refuses a lateral G38.3 X/Y when the unit allows top touches only', () => {
    const topOnly = motionOrderGuard(CLEARANCE, { lateralProbes: false });
    topOnly.observe('$H');
    topOnly.observe('G53 G0 Z-3');
    expect(topOnly.observe('G91')).toBeNull();
    expect(topOnly.observe('G38.3 X-3 F100')).toContain('top touches only');
    // A Z probe stays allowed; the default (no option) allows lateral probes.
    expect(topOnly.observe('G38.3 Z-10 F100')).toBeNull();
    const all = motionOrderGuard(CLEARANCE);
    all.observe('$H');
    all.observe('G91');
    expect(all.observe('G38.3 X-3 F100')).toBeNull();
  });

  it('#1199 field 7 — a descent below the clearance is allowed only over the stock footprint', () => {
    const stock = (machine: boolean, x: number, y: number) => !machine && x >= 0 && x <= 100 && y >= 0 && y <= 60;
    const guard = motionOrderGuard(CLEARANCE, { descentAllowed: stock });
    guard.observe('$H');
    guard.observe('G53 G0 Z-3');
    // Over the stock: the park descent is allowed.
    guard.observe('G0 X50 Y30');
    expect(guard.observe('G53 G0 Z-53')).toBeNull();
    // Beside the blank (the bench's seat point): refused.
    guard.observe('G53 G0 Z-3');
    guard.observe('G0 X-175 Y-35');
    expect(guard.observe('G53 G0 Z-81.25')).toContain('outside the stock');
    // An unknown XY before a descent: refused too.
    const fresh = motionOrderGuard(CLEARANCE, { descentAllowed: stock });
    fresh.observe('$H');
    expect(fresh.observe('G53 G0 Z-40')).toContain('XY is not known');
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

describe('#1199 field 7 — the plan’s descent region', () => {
  /** The badge blank, the four registry figures the region reads, and nothing else. */
  const planAt = (over: Record<string, unknown> = {}): RegistrationPlan =>
    ({
      mount: 'vise',
      bracketOrigin: null,
      holdUncertainty: { xMm: 0, yMm: 0 },
      settings: { probeFootprintShrinkMm: 3, tipRadiusMm: 0.7, edgeBandMm: 4 },
      probe: null,
      stock: { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 },
      scans: [],
      mountObstacles: [],
      mountTap: null,
      ...over,
    }) as unknown as RegistrationPlan;
  const scan = (edge: 'right' | 'back', along: number, start: number, limit: number): EdgeScan => ({
    edge,
    along,
    expectedAt: edge === 'right' ? 38.1 : 76.2,
    outward: 1,
    start,
    limit,
    coarseStep: 1,
    fineStep: 0.1,
  });

  it('allows the blank inside its top-touch margins, and refuses a point beside it', () => {
    const region = jobDescentRegion(planAt());
    expect(region(false, 19.05, 38.1)).toBe(true);
    // The 3 mm shrink: the outline's own 3 mm band is not a descent region.
    expect(region(false, 36, 38.1)).toBe(false);
    expect(region(false, 40, 38.1)).toBe(false);
  });

  it('allows a declared edge-find window beyond the collar, and refuses a point off its line', () => {
    // The right scan's limit is 5 mm past the edge; the collar alone would stop at edge + 4.
    const region = jobDescentRegion(planAt({ scans: [scan('right', 38.1, 35.1, 43.1)] }));
    expect(region(false, 43.1, 38.1)).toBe(true);
    expect(region(false, 43.1, 50)).toBe(false);
  });

  it('never allows a CLAMPED stretch of a declared window (the analyst’s rule)', () => {
    const clamp = { kind: 'clamp', label: 'a clamp', min: [40, 30], max: [46, 46], topZ: 12 };
    const region = jobDescentRegion(
      planAt({ scans: [scan('right', 38.1, 35.1, 43.1)], mountObstacles: [clamp] }),
    );
    expect(region(false, 43.1, 38.1)).toBe(false);
    expect(region(false, 39, 38.1)).toBe(true);
  });

  it('converts a bracket plan’s machine lines through its origin', () => {
    const region = jobDescentRegion(
      planAt({ mount: 'bracket', bracketOrigin: { x: -181.55, y: -184.8, from: 'anchor 1', offsetMeasured: true } }),
    );
    expect(region(true, -181.55 + 19.05, -184.8 + 38.1)).toBe(true);
    expect(region(true, -181.55 + 40, -184.8 + 38.1)).toBe(false);
  });

  it('a bracket plan (the tray) carries no mount tap, so its region has no tap clause', () => {
    // #1133/#1199 (analyst field 7 (e)) — a bracket plan has no mountTap, so the shipped tap
    // clause cannot fire on it: the morning tray build is unaffected by removing it.
    const region = jobDescentRegion(
      planAt({
        mount: 'bracket',
        bracketOrigin: { x: -181.55, y: -184.8, from: 'anchor 1', offsetMeasured: true },
        mountTap: null,
      }),
    );
    expect(region(true, -186.2, -180)).toBe(false);
  });

  it('does NOT admit the plan’s mount tap (ruling B: a jaw datum is a SETUP measurement)', () => {
    const tap = { x: -186.2, y: -180, fromMachineZ: -3, label: 'the vise fixed-jaw top' };
    const region = jobDescentRegion(planAt({ mountTap: tap }));
    // The vise jaw sits 4.65 mm beside the blank's left edge: a legacy plan carrying this tap is
    // refused at the tap like any point outside the region. A vise plan has no origin, so a
    // machine-frame line cannot be converted at all — the work-frame blank still admits a descent.
    expect(region(true, -186.2, -180)).toBe(false);
    expect(region(false, 19.05, 38.1)).toBe(true);
  });
});
