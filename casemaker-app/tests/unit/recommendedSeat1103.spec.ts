// #1103 — the recommended seat reads the work (the analyst's corrected rule, 2026-11-10): the jaws
// are in the cutter's way only where the cut goes below the jaw tops AND comes near the gripped
// edge. The real ledge step is 3.1 mm, so the 19.1 mm mesh on the 20.1 mm plate is 2.1 mm below the
// jaw tops on the ledge (the note's 1.4 assumed a 2.4 mm step).
import { describe, expect, it } from 'vitest';

import { boardSeatProud, facingForSeat, recommendSeat } from '@/components/welcome/holdingMounts';
import { KNOWN_DEFAULTS } from '@/platform/defaultsClient';

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
    // The house of the dev build: a 2 mm board only, so no board gets a 19.1 mm cut proud.
    const r = recommendSeat(PLATE, { deepestCutMm: 19.1, through: false, reachesEdgeWithinMm: 0 }, [BOARDS[0]!]);
    expect(r.mount).toBe('board');
    expect(r.bedSuggested).toBe(true);
    expect(r.reason).toContain('2.1 mm of the cut would be below the jaw tops');
    expect(r.reason).toContain('a thicker board, a taller blank, or tape it to the bed');
  });

  it('item 3 — with a 6 mm house board the same mesh job is a real board seat on the thinnest board that gets there', () => {
    const r = recommendSeat(PLATE, { deepestCutMm: 19.1, through: false, reachesEdgeWithinMm: 0 }, BOARDS);
    expect(r.mount).toBe('board');
    expect(r.boardMm).toBe(6);
    expect(r.bedSuggested).toBe(false);
    expect(r.reason).toContain('on a 6 mm board');
  });

  it('a 10 mm pocket reaching the edge on a 30 mm block moves to the jaw ledge', () => {
    const r = recommendSeat({ thickness: 30 }, { deepestCutMm: 10, through: false, reachesEdgeWithinMm: 5 }, BOARDS);
    expect(r.mount).toBe('ledge');
    expect(r.bedSuggested).toBe(false);
    expect(r.reason).toContain('the ledge keeps');
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

  it('#1207 — the chosen numbers are shop defaults with recommendations, not literals', () => {
    expect(KNOWN_DEFAULTS['vise.jawSideClearanceMm']?.fallback).toBe(6);
    expect(KNOWN_DEFAULTS['vise.cutProudMarginMm']?.fallback).toBe(1);
    expect(KNOWN_DEFAULTS['vise.jawTopToleranceMm']?.fallback).toBe(0.5);
  });

  it('item 2 — a through cut with an unknown margin is still never a vise seat', () => {
    const r = recommendSeat({ thickness: 12 }, { deepestCutMm: 12, through: true, reachesEdgeWithinMm: null }, BOARDS);
    expect(r.mount).toBe('board');
    expect(r.bedSuggested).toBe(true);
    expect(r.reason).not.toBeNull();
  });

  it('item 3 — a board seat takes the thinnest house board that keeps the cut + 1 mm proud', () => {
    // 10 mm blank, 8 mm cut reaching the edge: the ledge keeps 6.9 mm proud, short of cut + 1 = 9; the
    // floor board (the thinnest that leaves the blank proud) is 1 mm, but only the 6 mm board gets there.
    const boards = [
      { thickness: 1, material: 'MDF', count: 2 },
      { thickness: 2, material: 'MDF', count: 2 },
      { thickness: 6, material: 'MDF', count: 1 },
    ];
    const r = recommendSeat({ thickness: 10 }, { deepestCutMm: 8, through: false, reachesEdgeWithinMm: 0 }, boards);
    expect(r.mount).toBe('board');
    const proud = (b: number): number => boardSeatProud(10, b);
    const thinnest = boards.map((b) => b.thickness).find((b) => proud(b) >= 9)!;
    expect(thinnest).toBe(6);
    expect(r.boardMm).toBe(thinnest);
    expect(r.bedSuggested).toBe(false);
    // And when no board gets there, the thickest is the stated fallback.
    const none = recommendSeat({ thickness: 4 }, { deepestCutMm: 30, through: false, reachesEdgeWithinMm: 0 }, boards);
    expect(none.boardMm).toBe(6);
    expect(none.bedSuggested).toBe(true);
  });

  it('item 4 — the reason strings: one cut inside the edge, one reaching it', () => {
    const inside = recommendSeat({ thickness: 30 }, { deepestCutMm: 10, through: false, reachesEdgeWithinMm: 12 }, BOARDS);
    expect(inside.mount).toBe('block');
    expect(inside.reason).toBe(
      'on the block seat — the cut goes 10 mm down and stays 12 mm inside the blank’s edge; the block seat keeps 10 mm proud',
    );
    const edge = recommendSeat({ thickness: 30 }, { deepestCutMm: 10, through: false, reachesEdgeWithinMm: 0 }, BOARDS);
    expect(edge.mount).toBe('ledge');
    expect(edge.reason).toBe(
      'on the jaw ledge — the cut goes 10 mm down and reaches the blank’s edge; the ledge keeps 26.9 mm proud',
    );
  });

  it('item 6 — a vise seat the rule refused states the jaws’ height on its own row text', () => {
    const r = recommendSeat(PLATE, { deepestCutMm: 19.1, through: false, reachesEdgeWithinMm: 0 }, BOARDS);
    const ledge = r.refused.find((x) => x.mount === 'ledge');
    expect(ledge?.text).toBe(
      'The cut goes 19.1 mm down and reaches the blank’s edge; on this seat the jaws stand 2.1 mm above its floor there.',
    );
    expect(r.refused.map((x) => x.mount)).toContain('block');
  });

  it('item 7 — the facing seed and the arrival seat are the same seat', () => {
    // A 19.1 mm surfacing pass on a 20.1 plate: the arrival seat is not the block, so the facing
    // seed must be judged on the SAME seat as the Holding step arrives in.
    const work = { deepestCutMm: 19.1, through: false, reachesEdgeWithinMm: 0 };
    const seat = recommendSeat(PLATE, work, BOARDS);
    const facing = facingForSeat('rough' as never, 'hardwood' as never, PLATE, undefined, true, work, BOARDS);
    const proud = boardSeatProud(PLATE.thickness, seat.boardMm);
    expect(seat.mount).toBe('board');
    // The facing pass is enabled only where it ends above the jaw tops on that very seat.
    expect(facing.enabled).toBe(proud > facing.depth);
  });
});
