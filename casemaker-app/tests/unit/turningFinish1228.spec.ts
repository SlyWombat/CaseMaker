/**
 * #1228 (planner v3 E3b) — THE TURNING FINISHING HELIX. One slow helix follows the profile itself;
 * where the part is bigger than the rod the tool rides on the rod and cuts nothing. The expected
 * numbers are the analyst prototype's own (issue #1228); a disagreement is reported, not edited.
 */
import { describe, expect, it } from 'vitest';

import { turningFinishMoves, turningRoughMoves, turningTargetAt, type TurningInput } from '@/engine/cnc/cam/turning';
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
type FeedMove = Extract<CamMove, { kind: 'feed' }>;
type RapidMove = Extract<CamMove, { kind: 'rapid' }>;
const feeds = (m: CamMove[]): FeedMove[] => m.filter((x): x is FeedMove => x.kind === 'feed');
const rapids = (m: CamMove[]): RapidMove[] => m.filter((x): x is RapidMove => x.kind === 'rapid');

const FIN = { finishPitchMmPerTurn: 0.5, aStartDeg: 0 };
const MIXED = { ...BASE, ...FIN, profile: Array.from({ length: 61 }, (_, i) => (i * 0.5 < 15 ? 12 : 4)) };

describe('#1228 turning finishing helix', () => {
  it('a plain cylinder: one pass on the profile', () => {
    const m = turningFinishMoves({ ...CYLINDER, ...FIN });
    expect(m.length).toBe(579);
    expect(feeds(m).length).toBe(577);
    expect(rapids(m).length).toBe(2);
    for (const f of feeds(m)) expect(f.z).toBe(5);
  });

  it('it carries on from the roughing’s angle', () => {
    const m = turningFinishMoves({ ...CYLINDER, ...FIN });
    expect(m[0]!.a).toBe(0);
    expect(m[m.length - 1]!.a).toBe(-17280);
    const m2 = turningFinishMoves({ ...CYLINDER, ...FIN, aStartDeg: -17280 });
    expect(m2[0]!.a).toBe(-17280);
    expect(m2[m2.length - 1]!.a).toBe(-34560);
  });

  it('the rod never turns back', () => {
    const m = turningFinishMoves({ ...CYLINDER, ...FIN });
    for (let i = 1; i < m.length; i++) expect(m[i]!.a!).toBeLessThanOrEqual(m[i - 1]!.a! + 1e-9);
  });

  it('the tool stays on the axis and inside the span', () => {
    const m = turningFinishMoves({ ...CYLINDER, ...FIN });
    for (const move of m) expect(move.y).toBe(0);
    expect(Math.min(...feeds(m).map((x) => x.x))).toBeCloseTo(3, 9);
    expect(Math.max(...feeds(m).map((x) => x.x))).toBeCloseTo(27, 9);
    for (const r of rapids(m)) expect(r.z).toBe(13);
  });

  it('only the first feed is a plunge', () => {
    const m = turningFinishMoves({ ...CYLINDER, ...FIN });
    const first = m[1]!;
    if (first.kind !== 'feed') throw new Error('the move after the rapid must be the plunge');
    expect(first.f).toBe(200);
    for (const f of feeds(m).slice(1)) expect(f.f).toBe(600);
  });

  it('a stepped shaft: the tool follows the step', () => {
    const m = turningFinishMoves({ ...STEPPED, ...FIN });
    expect(m.length).toBe(579);
    const zs = new Set(feeds(m).map((x) => x.z));
    expect([...zs].sort((a, b) => a - b)).toEqual([4, 8]);
    for (const f of feeds(m)) {
      if (f.x <= 16.2) expect(f.z).toBe(8);
      if (f.x >= 16.3) expect(f.z).toBe(4);
    }
    expect(feeds(m).filter((x) => x.z === 8).length).toBe(319);
    expect(feeds(m).filter((x) => x.z === 4).length).toBe(258);
  });

  it('where the part is bigger than the rod the tool rides on the rod', () => {
    const m = turningFinishMoves(MIXED);
    const zs = new Set(feeds(m).map((x) => x.z));
    expect([...zs].sort((a, b) => a - b)).toEqual([4, 10]);
    for (const f of feeds(m)) expect(f.z).toBeLessThanOrEqual(10);
  });

  it('it never cuts below the target', () => {
    for (const input of [{ ...CYLINDER, ...FIN }, { ...STEPPED, ...FIN }, MIXED]) {
      const m = turningFinishMoves(input);
      for (const f of feeds(m)) {
        expect(f.z).toBeGreaterThanOrEqual(Math.min(input.stockRadiusMm, turningTargetAt(input, f.x)) - 1e-9);
      }
    }
  });

  it('an allowance is honoured', () => {
    const m = turningFinishMoves({ ...CYLINDER, ...FIN, allowanceMm: 0.2 });
    for (const f of feeds(m)) expect(f.z).toBeCloseTo(5.2, 9);
  });

  it('nothing to finish', () => {
    expect(turningFinishMoves({ ...BASE, ...FIN, profile: new Array(61).fill(12) })).toEqual([]);
    expect(turningFinishMoves({ ...CYLINDER, ...FIN, xFrom: 27, xTo: 3 })).toEqual([]);
  });

  it('bad numbers are refused', () => {
    expect(() => turningFinishMoves({ ...CYLINDER, ...FIN, finishPitchMmPerTurn: 0 })).toThrow();
    expect(() => turningFinishMoves({ ...CYLINDER, ...FIN, dx: 0 })).toThrow();
    expect(() => turningFinishMoves({ ...CYLINDER, ...FIN, degPerMove: 0 })).toThrow();
  });

  it('the roughing is untouched', () => {
    expect(turningRoughMoves(CYLINDER).length).toBe(585);
  });
});
