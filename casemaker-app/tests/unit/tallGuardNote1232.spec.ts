/**
 * #1232 (planner v3 A6) — THE TALL RULE KEPT A SLOWER SET: the helper that states what the
 * displacement cost.
 *
 * The set that counts is the one the pick WOULD have been with the tall term taken out and
 * everything else the same (chooseSequence sorts a copy that way); this helper compares the
 * chosen set with that displaced set. The analyst's first rule — the fastest set inside the
 * tolerance — was withdrawn (it named a set that had already lost on an earlier rank key).
 */
import { describe, expect, it } from 'vitest';

import { tallGuardSentence } from '@/engine/cnc/cam/model/plan';
import { tallGuardOf } from '@/engine/cnc/cam/model/sequence';

describe('#1232 the tall-guard note', () => {
  it('a displaced set that is taller and faster gives its numbers', () => {
    expect(tallGuardOf({ tallCells: 0, totalSeconds: 1000 }, { tallCells: 48, totalSeconds: 775 })).toEqual({
      extraTallCells: 48,
      givenUpSeconds: 225,
    });
  });

  it('a set that leaves no more tall cells was not passed over for tall material', () => {
    expect(tallGuardOf({ tallCells: 6, totalSeconds: 1000 }, { tallCells: 6, totalSeconds: 700 })).toBeNull();
    expect(tallGuardOf({ tallCells: 6, totalSeconds: 1000 }, { tallCells: 2, totalSeconds: 700 })).toBeNull();
  });

  it('a set that is not faster was not passed over for time', () => {
    expect(tallGuardOf({ tallCells: 0, totalSeconds: 1000 }, { tallCells: 48, totalSeconds: 1000 })).toBeNull();
    expect(tallGuardOf({ tallCells: 0, totalSeconds: 1000 }, { tallCells: 48, totalSeconds: 1200 })).toBeNull();
  });

  it('the given-up seconds are whole seconds, rounded', () => {
    expect(tallGuardOf({ tallCells: 0, totalSeconds: 1000.4 }, { tallCells: 3, totalSeconds: 999.6 })).toEqual({
      extraTallCells: 3,
      givenUpSeconds: 1,
    });
  });

  it('the sheet sentence — 48 cells at 0.01 mm² and 225 s, over a 1 mm tall limit', () => {
    expect(tallGuardSentence({ extraTallCells: 48, cellAreaMm2: 0.01, givenUpSeconds: 225 }, 1)).toBe(
      'A set of cutters about 4 min faster was passed over: it would leave 0.5 mm² more standing over 1 mm tall. ' +
        'Material that tall is never traded for time (a shop setting).',
    );
  });
});
