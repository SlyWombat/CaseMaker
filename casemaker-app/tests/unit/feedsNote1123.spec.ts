/**
 * #1123 item 8 — A BIT ON BORROWED FEEDS SAYS SO ON THE CUTTER ROW, not only in the details fold.
 *
 * The bench session's two new 6 mm bits and the 0.6 corn ran on "hardwood's largest covered row
 * (3.2 mm), the conservative side" — stated only in the plan's findings fold, although it is why
 * that day's cycle doubled. The fix: the substitution statement carries the borrowed row's diameter
 * as a typed field, and the cutter line (the main view's cutter row) prints a compact visible note:
 * "feeds: borrowed from the 3.2 mm row — slow".
 */
import { describe, expect, it } from 'vitest';

import { feedsProxyNotes } from '@/engine/cnc/engrave/substitution';

describe('#1123 item 8 — the borrowed-feeds note for the cutter row', () => {
  it('turns one substituted-feed statement into the row’s visible note', () => {
    const notes = feedsProxyNotes([
      { code: 'goal-cutter-substituted', feedsProxyMm: 3.2 },
    ]);
    expect(notes).toEqual(['feeds: borrowed from the 3.2 mm row — slow']);
  });

  it('ignores every statement that is not a borrowed-feed substitution', () => {
    expect(
      feedsProxyNotes([
        { code: 'goal-not-freed' },
        { code: 'goal-cutter-substituted' },
        { code: 'goal-cutter-substituted', feedsProxyMm: undefined },
      ]),
    ).toEqual([]);
  });

  it('names each distinct borrowed row once, however many cutters borrow it', () => {
    expect(
      feedsProxyNotes([
        { code: 'goal-cutter-substituted', feedsProxyMm: 3.2 },
        { code: 'goal-cutter-substituted', feedsProxyMm: 3.2 },
        { code: 'goal-cutter-substituted', feedsProxyMm: 6 },
      ]),
    ).toEqual(['feeds: borrowed from the 3.2 mm row — slow', 'feeds: borrowed from the 6 mm row — slow']);
  });
});
