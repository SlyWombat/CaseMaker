// #963 — what the plan could not cut, in the operator's words: C's #961 unplanned list and the
// "part not freed" line when no freeing cut is posted. The stub carries C's signature.

import { describe, expect, it } from 'vitest';
import { freeingSentence, planNoteLines, unplannedSentences } from '@/engine/cnc/engrave/planNotes';

describe('#963 the plan’s notes', () => {
  it('names every region a failed step could not cut, with the reason', () => {
    expect(
      unplannedSentences([
        { kind: 'pocket', cutterKey: 'flat-6', regionIds: ['p1', 'p2'], reason: 'the pocket op planned nothing for its regions' },
        { kind: 'contour', cutterKey: 'flat-6', regionIds: ['contour'], reason: 'the flute cannot reach the floor' },
      ]),
    ).toEqual([
      'p1: not cut — planning failed (the pocket op planned nothing for its regions)',
      'p2: not cut — planning failed (the pocket op planned nothing for its regions)',
      'contour: not cut — planning failed (the flute cannot reach the floor)',
    ]);
  });

  it('says a failure that names no region by its kind, so nothing is lost silently', () => {
    expect(unplannedSentences([{ kind: 'rest', cutterKey: 'ball-3', regionIds: [], reason: 'no smaller ball' }])).toEqual([
      'rest: not cut — planning failed (no smaller ball)',
    ]);
  });

  it('says the part is not freed when no freeing cut is posted, and says nothing when one is', () => {
    expect(freeingSentence(null)).toBe('The part is not freed — no freeing cut is posted.');
    expect(freeingSentence({ cutterKey: 'flat-6', extraToolChange: false })).toBeNull();
    // Absent is not null: a plan that does not report freeing is not claimed to free the part.
    expect(freeingSentence(undefined)).toBeNull();
  });

  it('reads the notes in reading order: what was missed, then freeing', () => {
    expect(
      planNoteLines({ unplanned: [{ kind: 'contour', cutterKey: 'flat-6', regionIds: ['contour'], reason: 'x' }], freeing: null }),
    ).toEqual(['contour: not cut — planning failed (x)', 'The part is not freed — no freeing cut is posted.']);
    expect(planNoteLines({})).toEqual([]);
  });
});
