/**
 * #1226 — TURNING ROUGHING PASSES, RED-FIRST.
 *
 * Planner v3, step E3a: the simplest lathe-style roughing on the 4th axis. A profile says the
 * radius to leave at each cell along the rod; the tool feeds along the rod while the rod turns
 * (a helix), steps closer to the axis, and repeats until it reaches the profile. The tool's tip
 * rides up over any profile higher than the pass's radius.
 *
 * The expected numbers are the analyst prototype's own (issue #1226); a disagreement is reported,
 * not edited.
 */
import { describe, expect, it } from 'vitest';

import { turningRoughMoves, turningTargetAt, type TurningInput } from '@/engine/cnc/cam/turning';
import type { CamMove } from '@/engine/cnc/cam/ir';

const BASE = {
  x0: 0,
  dx: 0.5,
  stockRadiusMm: 10,
  cutterRadiusMm: 1.5,
  stepDownMm: 2,
  pitchMmPerTurn: 1.5,
  allowanceMm: 0,
  clearanceMm: 3,
  floorRadiusMm: 1,
  xFrom: 3,
  xTo: 27,
  degPerMove: 30,
  feedMmPerMin: 600,
  plungeFeedMmPerMin: 200,
};
const CYLINDER: TurningInput = { ...BASE, profile: new Array(61).fill(5) }; // leave a radius of 5 everywhere
const STEPPED: TurningInput = {
  ...BASE,
  profile: Array.from({ length: 61 }, (_, i) => (i * 0.5 < 15 ? 8 : 4)),
};
const feeds = (m: CamMove[]) => m.filter((x) => x.kind === 'feed');
const rapids = (m: CamMove[]) => m.filter((x) => x.kind === 'rapid');

describe('#1226 turning roughing', () => {
  it('the target under the cutter’s width', () => {
    expect(turningTargetAt(STEPPED, 10)).toBe(8);
    expect(turningTargetAt(STEPPED, 16.25)).toBe(8);
    expect(turningTargetAt(STEPPED, 16.3)).toBe(4);
    expect(turningTargetAt({ ...CYLINDER, allowanceMm: 0.5 }, 10)).toBe(5.5);
    expect(turningTargetAt({ ...BASE, profile: new Array(61).fill(-Infinity) }, 10)).toBe(1);
    expect(turningTargetAt({ ...BASE, profile: new Array(61).fill(0.2) }, 10)).toBe(1);
  });

  it('a plain cylinder: three passes', () => {
    const m = turningRoughMoves(CYLINDER);
    expect(m.length).toBe(585);
    expect(feeds(m).length).toBe(579);
    expect(rapids(m).length).toBe(6);
    const feedZ = new Set(feeds(m).map((x) => x.z));
    expect([...feedZ].sort((a, b) => a - b)).toEqual([5, 6, 8]);
    expect(Math.min(...feeds(m).map((x) => x.z))).toBe(5);
  });

  it('the rod never turns back', () => {
    const m = turningRoughMoves(CYLINDER);
    for (let i = 1; i < m.length; i++) {
      expect(m[i]!.a!).toBeLessThanOrEqual(m[i - 1]!.a! + 1e-9);
    }
    expect(m[m.length - 1]!.a).toBe(-17280);
  });

  it('the tool stays on the rod’s axis and inside the span', () => {
    const m = turningRoughMoves(CYLINDER);
    for (const move of m) expect(move.y).toBe(0);
    for (const move of feeds(m)) {
      expect(move.x).toBeGreaterThanOrEqual(3 - 1e-9);
      expect(move.x).toBeLessThanOrEqual(27 + 1e-9);
    }
    expect(Math.min(...feeds(m).map((x) => x.x))).toBeCloseTo(3, 9);
    expect(Math.max(...feeds(m).map((x) => x.x))).toBeCloseTo(27, 9);
  });

  it('rapids travel clear of the rod', () => {
    const m = turningRoughMoves(CYLINDER);
    for (const move of rapids(m)) expect(move.z).toBe(13);
  });

  it('plunges use the plunge feed', () => {
    const m = turningRoughMoves(CYLINDER);
    const plunges = feeds(m).filter((x) => x.f === 200);
    expect(plunges).toHaveLength(3);
    for (let i = 0; i < m.length; i++) {
      const move = m[i]!;
      if (move.kind !== 'feed' || move.f !== 200) continue;
      expect(m[i - 1]!.kind).toBe('rapid');
    }
    for (const move of feeds(m)) if (move.f !== 200) expect(move.f).toBe(600);
  });

  it('a stepped shaft: the tool rides over the shoulder', () => {
    const m = turningRoughMoves(STEPPED);
    expect(m.length).toBe(585);
    expect(Math.min(...feeds(m).map((x) => x.z))).toBe(4);
    for (const move of feeds(m)) {
      if (move.x <= 16.25 + 1e-9) expect(move.z).toBeGreaterThanOrEqual(8 - 1e-9);
    }
    expect(feeds(m).some((move) => move.z === 4 && move.x >= 17)).toBe(true);
  });

  it('it never cuts below the target', () => {
    for (const input of [CYLINDER, STEPPED]) {
      for (const move of feeds(turningRoughMoves(input))) {
        expect(move.z).toBeGreaterThanOrEqual(turningTargetAt(input, move.x) - 1e-9);
      }
    }
  });

  it('an allowance is left', () => {
    const m = turningRoughMoves({ ...CYLINDER, allowanceMm: 0.5 });
    expect(Math.min(...feeds(m).map((x) => x.z))).toBe(5.5);
  });

  it('nothing to remove', () => {
    expect(turningRoughMoves({ ...BASE, profile: new Array(61).fill(12) })).toEqual([]);
    expect(turningRoughMoves({ ...CYLINDER, xFrom: 27, xTo: 3 })).toEqual([]);
  });

  it('bad numbers are refused', () => {
    expect(() => turningRoughMoves({ ...CYLINDER, stepDownMm: 0 })).toThrow();
    expect(() => turningRoughMoves({ ...CYLINDER, pitchMmPerTurn: 0 })).toThrow();
    expect(() => turningRoughMoves({ ...CYLINDER, dx: 0 })).toThrow();
    expect(() => turningRoughMoves({ ...CYLINDER, degPerMove: 0 })).toThrow();
  });
});
