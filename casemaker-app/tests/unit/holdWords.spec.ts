// #1101 — the hold's words follow the mount: a block's axes are "between the jaws" only under the
// vice; on the bed they are left-right / front-back; the rotary offers no cards at all.
import { describe, expect, it } from 'vitest';

import { holdCutFaceWords, holdWordsForMount } from '@/engine/cnc/engrave/stockHold';

const BLOCK = { length: 36, width: 100, thickness: 36 };
const HOLD = { x: 'length', y: 'width', z: 'thickness' } as const;

describe('#1101 the hold words follow the mount', () => {
  it('a block on the bed says left to right and front to back, and never a jaw', () => {
    const words = holdWordsForMount('bed', 'block', HOLD, BLOCK);
    expect(words).toContain('left to right');
    expect(words).toContain('front to back');
    expect(words).not.toMatch(/jaw/i);
  });

  it('the same block in the vise keeps its between-the-jaws words', () => {
    const words = holdWordsForMount('vise', 'block', HOLD, BLOCK);
    expect(words).toContain('between the jaws');
  });

  it('a rod on the bed has no jaw words either', () => {
    const rod = { length: 100, width: 12, thickness: 12 };
    expect(holdWordsForMount('bed', 'rod', { x: 'width', y: 'thickness', z: 'length' }, rod)).not.toMatch(/jaw/i);
  });

  // #1101 item 2 — a rod lying across the bed's hold cards is on the bed, not across any jaw.
  it('a rod’s cut-face words on the bed have no jaw', () => {
    const lying = { x: 'thickness', y: 'length', z: 'width' } as const;
    expect(holdCutFaceWords('rod', lying, 'bed')).toBe('cut on the curved side, lying on the bed');
    expect(holdCutFaceWords('rod', lying, 'vise')).toBe('cut on the curved side, lying across the jaws');
    expect(holdCutFaceWords('rod', lying, 'bed')).not.toMatch(/jaw/i);
  });

  // #1101 item 3 — the chuck decides a rod's axis, so the rotary has no hold words (and no cards).
  it('rotary has no hold words', () => {
    expect(holdWordsForMount('rotary', 'rod', { x: 'width', y: 'thickness', z: 'length' }, { length: 100, width: 12, thickness: 12 })).toBe('');
  });
});
