// #1192 rule 2 — THE EXACT DOMINANCE PRUNE (the analyst's field, issue comment 6780932595).
//
// A candidate is dropped unpriced when a KEPT one has the same shape and the SAME FEED ROW (own,
// or the same borrowed numbers), at least as long a STATED reach and at least as large a diameter
// — on one row a larger cutter cannot cut slower — and covers every region the dropped one could.
// A larger cutter that cannot enter a narrow region does not dominate there, an unstated reach
// never dominates, and a different row never does. A dropped primary stays a rest/finish
// candidate, so this file asserts the PRIMARIES the candidates start from.
import { describe, expect, it } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
import { candidateSequences, type SequenceDemand } from '@/engine/cnc/cam/model/sequence';

// A generous corner (radius 4) so the ⌀6 fits it: the plain pocket is a region both flats cover.
const POCKET: SequenceDemand['features'][number] = { id: 'pocket', kind: 'pocket', cornerRadiusMm: 4, minOpeningMm: 8, depthMm: 5 };
// A 4 mm slot: the ⌀3.175 enters it and the ⌀6 does not — the near-miss region.
const NARROW: SequenceDemand['features'][number] = { id: 'narrow', kind: 'pocket', cornerRadiusMm: 0.5, minOpeningMm: 4, cornerRadiusMm: 2, depthMm: 1 };

const big = flatEndMill(6, { id: 'big', name: '⌀6 flat', number: 1, fluteLength: 30 });
const small = flatEndMill(3.175, { id: 'small', name: '⌀3.175 flat', number: 2, fluteLength: 30 });

const startsOf = (demand: SequenceDemand, house: typeof big[]): Set<string> =>
  new Set(candidateSequences(demand, { house, catalogue: [] }).map((c) => c.steps[0]?.cutter.key ?? 'none'));

describe('#1192 rule 2 — the exact dominance prune', () => {
  it('a candidate dominated on one row, by a larger cutter that covers every region it could, is dropped', () => {
    // Both state 30 mm of flute and run the same row (the caller gives no rowKey here, so the
    // feeds kind is the row); the ⌀6 enters and reaches the only pocket, so nothing keeps the
    // ⌀3.175 as a primary.
    const starts = startsOf({ features: [POCKET], scallopMm: 0.05 }, [big, small]);
    expect(starts.has('big')).toBe(true);
    expect(starts.has('small'), 'the dominated ⌀3.175 was offered as a primary').toBe(false);
  });

  it('a near-miss is kept: the smaller cutter is the only one that enters a narrow region', () => {
    // The ⌀6 cannot enter the 2 mm opening, so it does not cover every region the ⌀3.175 can —
    // no dominance, and both remain primaries.
    const starts = startsOf({ features: [POCKET, NARROW], scallopMm: 0.05 }, [big, small]);
    expect(starts.has('big')).toBe(true);
    expect(starts.has('small')).toBe(true);
  });

  it('a different feed row is never dominated', () => {
    // The smaller cutter borrows a slower row: the numbers differ, so the two are not comparable
    // by the rule (a cheaper row on the smaller cutter can win).
    const starts = new Set(
      candidateSequences(
        { features: [POCKET], scallopMm: 0.05 },
        {
          house: [big, small],
          catalogue: [],
          rowKey: (tool) => (tool.id === 'small' ? '400:0.5:0.45' : '1000:1:0.45'),
        },
      ).map((c) => c.steps[0]?.cutter.key ?? 'none'),
    );
    expect(starts.has('small'), 'a slower-own-row sibling was pruned').toBe(true);
  });

  it('an unstated reach never dominates (unknown is not at least as long)', () => {
    const unknown = flatEndMill(6, { id: 'unknown', name: '⌀6 flat · unstated flute', number: 3, fluteLength: null });
    const starts = startsOf({ features: [POCKET], scallopMm: 0.05 }, [unknown, small]);
    expect(starts.has('small'), 'an unstated flute dominated a stated one').toBe(true);
  });

  it('two otherwise-identical cutters keep exactly one, deterministically by key', () => {
    const twin = flatEndMill(3.175, { id: 'small', name: '⌀3.175 flat (twin)', number: 4, fluteLength: 30 });
    const starts = startsOf({ features: [POCKET], scallopMm: 0.05 }, [small, twin]);
    expect(starts.size).toBe(1);
  });
});
