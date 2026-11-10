// #1101 — the hold's words follow the mount: a block's axes are "between the jaws" only under the
// vice; on the bed they are left-right / front-back; the rotary offers no cards at all.
import { describe, expect, it } from 'vitest';

import { holdWordsForMount } from '@/engine/cnc/engrave/stockHold';

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
});
