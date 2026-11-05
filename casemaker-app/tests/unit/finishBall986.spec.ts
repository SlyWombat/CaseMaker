/**
 * #986 — THE FINISHING BALL'S CANDIDATE LIST. The defect the issue names is a RULE: the ball was
 * "the largest diameter, first in catalogue order", which bridged every crease narrower than its
 * radius (the panther: 61.84 % against the owned plan's 83.05 %). The candidate list is the first
 * half of the fix: one ball per cutting diameter, the longest flute of each, REACH-FILTERED against
 * the deepest remainder, and never ordered by catalogue position.
 *
 * The second half — measuring each candidate by finishing and stamping, and choosing by leftover
 * then cycle — is wired in `planModelCam`; this file pins the list it ranks.
 */

import { describe, expect, it } from 'vitest';

import { finishBallCandidates } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const ball = (dia: number, flute: number, id: string): Tool => ({
  ...flatEndMill(dia, { number: 1, id, name: id }),
  shape: 'ball',
  typeText: 'Ball Nose',
  fluteLength: flute,
});

describe('#986 the finishing ball candidates', () => {
  it('keeps one ball per diameter — the longest flute — and never picks by catalogue order', () => {
    // The union's shape: several balls per diameter, catalogued biggest-first.
    const house = [
      ball(6, 12, '131032605012'),
      ball(6, 18, '6x18-metal'),
      ball(6, 32, '6x32'),
      ball(4, 32, '4x32'),
      ball(2, 6, 'ball-2'),
      ball(0.5, 2, 'ball-0.5'),
    ];
    const candidates = finishBallCandidates(house, 20);
    // 6 mm flutes: 12/18/32 → one candidate, the 32 mm one; 4 mm × 32 reaches; 2 × 6 and 0.5 × 2
    // do NOT reach 20 mm and are filtered out.
    expect(candidates.map((t) => t.id)).toEqual(['6x32', '4x32']);
  });

  it('drops a ball that cannot reach the deepest remainder — the panther’s 26 mm', () => {
    const house = [ball(6, 12, '131032605012'), ball(4, 32, '4x32'), ball(2, 6, 'ball-2'), ball(1, 30.5, '161032105031')];
    const candidates = finishBallCandidates(house, 26);
    // The ⌀6 × 12 the old rule picked first is gone: its flute cannot descend 26 mm.
    expect(candidates.map((t) => t.id).sort()).toEqual(['161032105031', '4x32']);
    expect(candidates.some((t) => t.id === '131032605012')).toBe(false);
  });

  it('when nothing reaches, states the one longest ball instead of picking by size', () => {
    const house = [ball(6, 12, 'big'), ball(2, 8, 'small')];
    const candidates = finishBallCandidates(house, 26);
    expect(candidates.map((t) => t.id)).toEqual(['big']);
  });

  it('ignores cutters that are not balls, and balls with no diameter', () => {
    const house = [flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' }), { ...ball(2, 30, 'b2'), diameter: 0, tipDiameter: 0 }];
    expect(finishBallCandidates(house, 5)).toEqual([]);
  });
});
