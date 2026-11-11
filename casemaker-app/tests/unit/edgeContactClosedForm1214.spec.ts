// #1214 — planner v3 slice 1: the drop-cutter's edge contact finds its maximum in closed form for
// the ball and the V, instead of a golden-section search. The expected values below were checked to
// 1e-9 by the analyst's prototype; a failure here means the implementation is wrong, never the
// expected value.
import { describe, expect, it } from 'vitest';

import { edgeContactMax, heightAt, type CutterProfile } from '@/engine/cnc/cam/model/dropcutter';

const BALL3: CutterProfile = { radiusMm: 3, flatRadiusMm: 0, kind: 'arc', curveRadiusMm: 3 };
const V90: CutterProfile = { radiusMm: 5, flatRadiusMm: 0, kind: 'cone', tanHalfAngle: 1 };
const V90_FLAT: CutterProfile = { radiusMm: 5, flatRadiusMm: 0.5, kind: 'cone', tanHalfAngle: 1 };
const BULL: CutterProfile = { radiusMm: 3, flatRadiusMm: 2, kind: 'arc', curveRadiusMm: 1 };

/** The tool axis is at (0, 0) in every test. */
const contact = (
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  profile: CutterProfile,
): number | null => edgeContactMax(x0, y0, z0, x1, y1, z1, 0, 0, profile);

describe('#1214 exact edge contact — ball and V', () => {
  it('A ball over a level edge', () => {
    expect(contact(-10, 1, 0, 10, 1, 0, BALL3)).toBeCloseTo(Math.sqrt(8) - 3, 6);
  });

  it('B ball over a 45° edge', () => {
    expect(contact(-10, 1, -10, 10, 1, 10, BALL3)).toBeCloseTo(1, 6);
  });

  it('C ball, best point before the interval starts', () => {
    expect(contact(2.5, 1, 2.5, 10, 1, 10, BALL3)).toBeCloseTo(2.5 + Math.sqrt(1.75) - 3, 6);
  });

  it('D ball, edge out of reach', () => {
    expect(contact(5, 1, 5, 10, 1, 10, BALL3)).toBeNull();
  });

  it('E V over a level edge', () => {
    expect(contact(-10, 1, 0, 10, 1, 0, V90)).toBeCloseTo(-1, 6);
  });

  it('F V over a sloped edge', () => {
    expect(contact(-10, 1, -5, 10, 1, 5, V90)).toBeCloseTo(-Math.sqrt(0.75), 6);
  });

  it('G V with a tip flat, edge under the flat', () => {
    expect(contact(-10, 0.2, 0, 10, 0.2, 0, V90_FLAT)).toBeCloseTo(0, 6);
  });

  it('H agrees with a dense scan, many random edges', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const profiles = [BALL3, V90, V90_FLAT];
    let numeric = 0;
    for (let i = 0; i < 300; i++) {
      const profile = profiles[i % 3]!;
      const x0 = rnd() * 12 - 6;
      const y0 = rnd() * 12 - 6;
      const x1 = rnd() * 12 - 6;
      const y1 = rnd() * 12 - 6;
      const z0 = rnd() * 8 - 4;
      const z1 = rnd() * 8 - 4;
      const result = contact(x0, y0, z0, x1, y1, z1, profile);
      if (result === null) continue;
      numeric++;
      let reference = -Infinity;
      for (let n = 0; n <= 20000; n++) {
        const s = n / 20000;
        const px = x0 + s * (x1 - x0);
        const py = y0 + s * (y1 - y0);
        const pz = z0 + s * (z1 - z0);
        const rho = Math.hypot(px, py);
        if (rho > profile.radiusMm) continue;
        const value = pz - heightAt(profile, rho);
        if (value > reference) reference = value;
      }
      expect(result, `edge ${i} (${profile.kind})`).toBeGreaterThanOrEqual(reference - 1e-9);
      expect(result, `edge ${i} (${profile.kind})`).toBeLessThanOrEqual(reference + 2e-3);
    }
    expect(numeric).toBeGreaterThanOrEqual(100);
  });

  it('I the bull nose is unchanged', () => {
    const [x0, y0, z0, x1, y1, z1] = [-10, 1, -10, 10, 1, 10] as const;
    const result = contact(x0, y0, z0, x1, y1, z1, BULL)!;
    let reference = -Infinity;
    for (let n = 0; n <= 20000; n++) {
      const s = n / 20000;
      const px = x0 + s * (x1 - x0);
      const py = y0 + s * (y1 - y0);
      const pz = z0 + s * (z1 - z0);
      const rho = Math.hypot(px, py);
      if (rho > BULL.radiusMm) continue;
      const value = pz - heightAt(BULL, rho);
      if (value > reference) reference = value;
    }
    expect(result).toBeCloseTo(reference, 4);
  });
});
