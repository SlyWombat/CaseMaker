// #1103 — the recommended seat reads the work (the analyst's corrected rule, 2026-11-10): the jaws
// are in the cutter's way only where the cut goes below the jaw tops AND comes near the gripped
// edge. The real ledge step is 3.1 mm, so the 19.1 mm mesh on the 20.1 mm plate is 2.1 mm below the
// jaw tops on the ledge (the note's 1.4 assumed a 2.4 mm step).
import { describe, expect, it } from 'vitest';

import { JAW_SIDE_CLEARANCE_MM, recommendSeat } from '@/components/welcome/holdingMounts';

const BOARDS = [
  { thickness: 2, material: 'MDF', count: 4 },
  { thickness: 6, material: 'MDF', count: 1 },
];
const PLATE = { thickness: 20.1 };

describe('#1103 the recommended seat reads the work', () => {
  it('a shallow text cut in the middle keeps the block seat, as today', () => {
    const r = recommendSeat(PLATE, { deepestCutMm: 0.5, through: false, reachesEdgeWithinMm: 20 }, BOARDS);
    expect(r.mount).toBe('block');
    expect(r.bedSuggested).toBe(false);
    expect(r.reason).toContain('mm inside the blank’s edge');
  });

  it('the 19.1 mm mesh reaching the edge refuses the block and the ledge: the bed is suggested, the board is the stated fallback', () => {
    const r = recommendSeat(PLATE, { deepestCutMm: 19.1, through: false, reachesEdgeWithinMm: 0 }, BOARDS);
    expect(r.mount).toBe('board');
    expect(r.bedSuggested).toBe(true);
    expect(r.reason).toContain('2.1 mm of the cut would be below the jaw tops');
    expect(r.reason).toContain('a thicker board, a taller blank, or tape it to the bed');
  });

  it('a 10 mm pocket reaching the edge on a 30 mm block moves to the jaw ledge', () => {
    const r = recommendSeat({ thickness: 30 }, { deepestCutMm: 10, through: false, reachesEdgeWithinMm: 5 }, BOARDS);
    expect(r.mount).toBe('ledge');
    expect(r.bedSuggested).toBe(false);
    expect(r.reason).toContain('jaw ledge keeps');
  });

  it('a through cutout is never a vise seat: the bed is suggested, the board is the fallback', () => {
    const r = recommendSeat({ thickness: 12 }, { deepestCutMm: 12, through: true, reachesEdgeWithinMm: 0 }, BOARDS);
    expect(r.mount).toBe('board');
    expect(r.bedSuggested).toBe(true);
  });

  it('a 3 mm sheet with a 1 mm pocket is the board seat, as today', () => {
    expect(recommendSeat({ thickness: 3 }, { deepestCutMm: 1, through: false, reachesEdgeWithinMm: 50 }, BOARDS).mount).toBe('board');
  });

  it('with no item yet the thickness rule stands, unchanged', () => {
    expect(recommendSeat(PLATE, null, BOARDS).mount).toBe('block');
    expect(recommendSeat({ thickness: 3 }, { deepestCutMm: 0, through: false, reachesEdgeWithinMm: null }, BOARDS).mount).toBe('board');
  });

  it('the jaw-side clearance is the named 6 mm', () => {
    expect(JAW_SIDE_CLEARANCE_MM).toBe(6);
  });
});
