// Saying what a printed box code was read as (#378), and naming a shape.
//
// This sentence is the only thing the user has to check the box in their hand against, so what it
// says — and what it leaves out — is the point. It is built from a real code rather than a
// hand-made `BoxCode`, so a change to the parser's reading shows up here as changed prose.

import { describe, it, expect } from 'vitest';
import { describeReading, SHAPE_LABELS, TYPABLE_SHAPES } from '@/components/manage/doors/reading';
import { parseBoxCode } from '@/engine/cnc/registerCutter';

/** The reading of a real printed code, as the panel gets it. */
function readingOf(code: string): string {
  const box = parseBoxCode(code);
  if (box === null) throw new Error(`${code} did not read as a box code`);
  return describeReading(box);
}

describe('describeReading', () => {
  it('says an engraving code’s angle before its tip, in the order the label prints them (#378)', () => {
    // Read as `<tip>-<flute>` this sentence was "engraving cutter, 30 mm tip, 0.3 mm flute".
    expect(readingOf('C1-BIT-ENGRAVE-30-0.3')).toBe('engraving cutter, 30°, 0.3 mm tip');
    expect(readingOf('C1-BIT-ENGRAVE-M-60-0.1')).toBe('engraving cutter, 60°, 0.1 mm tip');
  });

  it('keeps the degree sign, so the angle cannot read as another length', () => {
    expect(readingOf('C1-BIT-ENGRAVE-30-0.5')).toContain('30°');
    expect(readingOf('C1-BIT-ENGRAVE-30-0.5')).not.toContain('30.0');
  });

  it('says a chamfer code’s one number as the angle, and claims nothing else (#380)', () => {
    expect(readingOf('C1-BIT-CHAMFER-90')).toBe('chamfer mill, 90°');
  });

  it('says a thread code’s spec, which is a size and not a measurement (#380)', () => {
    expect(readingOf('C1-BIT-THREAD-M5-15')).toBe('thread mill, M5 thread, 15.0 mm flute');
  });

  it('says the ball nose the bench cuts with as the box states it', () => {
    expect(readingOf('C1-BIT-BALL-NOSE-1-4')).toBe('ball nose, 1.0 mm tip, 4.0 mm flute');
  });

  it('leaves out what the code did not state rather than printing a placeholder', () => {
    // A `—` would make this prose read like a table with a missing cell.
    expect(readingOf('C1-BIT-FLAT-2-0')).toBe('flat end mill, 2.0 mm tip');
  });

  it('says the numbers it read even when it could not name the shape, and claims no shape', () => {
    // Nothing is invented for a word this app does not know: the sentence keeps what the label
    // stated and says nothing about the shape (#377).
    expect(readingOf('C1-BIT-WIDGET-2-6')).toBe('2.0 mm tip, 6.0 mm flute');
  });

  it('names every shape the Type door offers, so the two lists cannot drift', () => {
    for (const shape of TYPABLE_SHAPES) expect(SHAPE_LABELS[shape]).not.toBe('unknown shape');
  });
});
