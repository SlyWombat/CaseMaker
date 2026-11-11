/**
 * #1232 (planner v3 A6) — THE TALL RULE KEPT A SLOWER SET: the helper that says so.
 *
 * The leftover tolerance (#1217) treats sets within a share of each other as equal on leftover,
 * and time decides. The tall rule (#1224) refuses to take a faster set that leaves more material
 * standing above `plan.leftoverTallMm`. When that rule is what kept a slower set, the sheet has
 * had no reason to give; this helper finds the faster, taller set that was passed over, so the
 * sentence can name it.
 */
import { describe, expect, it } from 'vitest';

import { tallGuardNote } from '@/engine/cnc/cam/model/sequence';

const SETS = [
  { tallCells: 0, leftoverCells: 100, totalSeconds: 1000 },
  { tallCells: 5, leftoverCells: 120, totalSeconds: 800 },
  { tallCells: 0, leftoverCells: 90, totalSeconds: 1500 },
  { tallCells: 7, leftoverCells: 130, totalSeconds: 700 },
  { tallCells: 9, leftoverCells: 400, totalSeconds: 100 },
];

describe('#1232 the tall-guard note', () => {
  it('the fastest set the tall rule passed over', () => {
    expect(tallGuardNote(SETS, 0, 0.5, 10000)).toEqual({ refusedIndex: 3, extraTallCells: 7, givenUpSeconds: 300 });
  });

  it('measured against the chosen set', () => {
    expect(tallGuardNote(SETS, 2, 0.5, 10000)).toEqual({ refusedIndex: 3, extraTallCells: 7, givenUpSeconds: 800 });
  });

  it('a set outside the tolerance is not mentioned', () => {
    expect(tallGuardNote([SETS[0]!, SETS[4]!], 0, 0.5, 10000)).toBeNull();
  });

  it('nothing faster and taller: no note', () => {
    expect(tallGuardNote([SETS[0]!, SETS[2]!], 0, 0.5, 10000)).toBeNull();
  });

  it('a faster set with no more tall cells is not this rule’s business', () => {
    expect(
      tallGuardNote([SETS[0]!, { tallCells: 0, leftoverCells: 110, totalSeconds: 500 }], 0, 0.5, 10000),
    ).toBeNull();
  });

  it('tolerance off: no note', () => {
    expect(tallGuardNote(SETS, 0, 0, 10000)).toBeNull();
  });

  it('a tie on time goes to the earlier set', () => {
    const tied = SETS.map((s, i) => (i === 1 ? { ...s, totalSeconds: 700 } : s));
    expect(tallGuardNote(tied, 0, 0.5, 10000)?.refusedIndex).toBe(1);
  });

  it('bad index', () => {
    expect(tallGuardNote(SETS, -1, 0.5, 10000)).toBeNull();
    expect(tallGuardNote(SETS, 5, 0.5, 10000)).toBeNull();
  });
});
