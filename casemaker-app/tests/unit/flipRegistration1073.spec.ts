/**
 * #1073 — SIDE 2'S REGISTRATION, PER FLIP METHOD.
 *
 * A flip changes which edge gives what to the probe, so the registration plan depends on the
 * method the operator chose:
 *
 *   - FRAME (tabs-in-blank): the front edge pair finds Y and the turn; ONE touch on the fence-side
 *     edge seeds X; the two locating bores side 1 left (⌀5–6, the setup's stored pins) are entered
 *     and touched +X/−X/+Y/−Y each with a G38.5 release — exact X, and the turn cross-checked
 *     against the front pair;
 *   - VENDOR (free-then-flip): the freed part is posed on its own front edge; the pair of touches
 *     runs on that straight edge (Y and the turn), the fence-side extreme seeds X — no holes.
 *
 * House rule #518 stands: every probe is `G38.3`, never `G38.2` (a miss is a reading, not an
 * alarm); a triggered sideways touch is released with `G38.5`.
 *
 * RED at m1-land8: no such planner exists — a flip's registration is stamped from the mount and
 * the axis cannot change which edge is touched.
 */
import { describe, expect, it } from 'vitest';

import { planFlipRegistration } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { PROBE_RESIDUAL_MM } from '@/engine/cnc/probePlan';

const S = registrationSettings(null).settings;

const BLANK = { xMin: 0, yMin: 0, xMax: 100, yMax: 60, cornerRadius: 3 };
/** The frame plan's hold: the 30/70 % line behind the part, W − 4. */
const PINS = [
  { x: 30, y: 56 },
  { x: 70, y: 56 },
] as const;

const FRAME = {
  method: 'tabs-in-blank' as const,
  stock: BLANK,
  holes: PINS,
  boreDiameterMm: 5,
  probeTipDiameterMm: 2,
  settings: S,
};

const keepOff = BLANK.cornerRadius + S.cornerClearanceMm;

describe('#1073 the frame method registers on the front pair, the X seed and two bores', () => {
  it('lists the seed touch then the two hole finds, after the front pair', () => {
    const r = planFlipRegistration(FRAME);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps.map((s) => s.kind)).toEqual(['edge-pair', 'seed', 'hole', 'hole']);
    const pair = r.plan.steps[0]!;
    if (pair.kind !== 'edge-pair') throw new Error('first step is the front pair');
    expect(pair.scans.map((s) => s.edge)).toEqual(['front', 'front']);
    expect(pair.scans[0]!.along).toBeCloseTo(BLANK.xMin + keepOff, 6);
    expect(pair.scans[1]!.along).toBeCloseTo(BLANK.xMax - keepOff, 6);
    const seed = r.plan.steps[1]!;
    if (seed.kind !== 'seed') throw new Error('second step is the seed');
    expect(seed.scan.edge).toBe('left');
    expect(seed.scan.along).toBeCloseTo(30, 6);
  });

  it('each hole find carries the bore, the entry depth and the four touch moves with their releases', () => {
    const r = planFlipRegistration(FRAME);
    if (!r.ok) throw new Error(r.reason);
    const finds = r.plan.steps.filter((s) => s.kind === 'hole').map((s) => (s.kind === 'hole' ? s.find : null));
    expect(finds).toHaveLength(2);
    for (const [i, find] of finds.entries()) {
      expect(find!.at).toEqual(PINS[i]);
      expect(find!.boreDiameterMm).toBe(5);
      expect(find!.ballRadiusMm).toBe(1);
      // The wall is (⌀bore − ⌀tip)/2 = 1.5 mm from the centre; the search adds the seed's own error.
      expect(find!.searchMm).toBeCloseTo(2.5, 6);
      // The entry depth is the fixture's 3 mm below side 2's top; the plunge starts at the park height.
      expect(find!.entryDepthMm).toBe(3);
      expect(find!.plungeMm).toBeCloseTo(S.parkAboveSurfaceMm + 3, 6);
      // +X, −X, +Y, −Y from the seeded centre.
      expect(find!.touches.map((t) => `${t.axis}${t.sign > 0 ? '+' : '-'}`)).toEqual(['x+', 'x-', 'y+', 'y-']);
      for (const t of find!.touches) {
        expect(t.from).toEqual(PINS[i]);
        expect(Math.abs(t.travelMm)).toBeCloseTo(2.5, 6);
      }
      expect(find!.releaseMm).toBe(3);
    }
  });

  it('the turn is cross-checked between the front pair and the bore line, with a derived tolerance', () => {
    const r = planFlipRegistration(FRAME);
    if (!r.ok) throw new Error(r.reason);
    const check = r.plan.crossCheck!;
    expect(check).not.toBeNull();
    expect(check.separationMm).toBeCloseTo(40, 6);
    expect(check.expectedAngleDeg).toBeCloseTo(0, 6);
    // Each pair reads its angle to 2r/sep; the difference is bounded by the sum, in degrees.
    const frontSep = BLANK.xMax - BLANK.xMin - 2 * keepOff;
    const want = ((2 * PROBE_RESIDUAL_MM) / frontSep + (2 * PROBE_RESIDUAL_MM) / 40) * (180 / Math.PI);
    expect(check.angleToleranceDeg).toBeCloseTo(want, 3);
    expect(check.angleToleranceDeg).toBeGreaterThan(0);
  });

  it('refuses by name when the bores or the probe do not fit', () => {
    const noHoles = planFlipRegistration({ ...FRAME, holes: undefined });
    expect(noHoles.ok).toBe(false);
    if (!noHoles.ok) expect(noHoles.reason).toContain('bore');
    const fat = planFlipRegistration({ ...FRAME, probeTipDiameterMm: 4.5 });
    expect(fat.ok).toBe(false);
    if (!fat.ok) expect(fat.reason).toContain('5');
  });

  it('a blank too small to read a turn on its front edge is refused with the numbers', () => {
    const r = planFlipRegistration({ ...FRAME, stock: { ...BLANK, xMax: 12 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('turn');
  });
});

describe('#1073 the vendor method registers on the freed part’s own edges', () => {
  const PART = { xMin: 10, yMin: 8, xMax: 34, yMax: 28, cornerRadius: 0 };
  const VENDOR = {
    method: 'free-then-flip' as const,
    stock: PART,
    frontStraight: { minX: 10, maxX: 34 },
    leftSeedY: 18,
    settings: S,
  };

  it('lists the part-edge pair and the fence-side seed, and no hole finds', () => {
    const r = planFlipRegistration(VENDOR);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps.map((s) => s.kind)).toEqual(['edge-pair', 'seed']);
    const pair = r.plan.steps[0]!;
    if (pair.kind !== 'edge-pair') throw new Error('first step is the pair');
    expect(pair.scans[0]!.along).toBeCloseTo(10 + S.cornerClearanceMm, 6);
    expect(pair.scans[1]!.along).toBeCloseTo(34 - S.cornerClearanceMm, 6);
    const seed = r.plan.steps[1]!;
    if (seed.kind !== 'seed') throw new Error('second step is the seed');
    expect(seed.scan.edge).toBe('left');
    expect(seed.scan.along).toBeCloseTo(18, 6);
  });

  it('the method decides WHO frees: the vendor plan needs no bores at all', () => {
    const r = planFlipRegistration({ ...VENDOR, holes: PINS, boreDiameterMm: 5, probeTipDiameterMm: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.steps.some((s) => s.kind === 'hole')).toBe(false);
  });

  it('a disc — no straight edge — is unavailable by name, with the reason', () => {
    const disc = planFlipRegistration({ ...VENDOR, frontStraight: { minX: 20, maxX: 22 } });
    expect(disc.ok).toBe(false);
    if (!disc.ok) expect(disc.reason).toContain('straight');
  });
});
