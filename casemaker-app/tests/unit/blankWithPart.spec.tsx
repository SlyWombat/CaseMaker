// @vitest-environment jsdom
// #1099 — the part on the blank: one footprint, four margins, and a clipped warning when the part
// no longer fits.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { BlankWithPart, blankMargins, overrunSentence } from '@/components/welcome/BlankWithPart';

afterEach(cleanup);

const BLANK = { length: 75, width: 72.7, thickness: 20.1 };
const PART = { kind: 'mesh' as const, length: 65, width: 62.7, height: 19.1 };

describe('#1099 — the part drawn on the blank', () => {
  it('75 × 72.7 blank with a 65 × 62.7 part: 5 mm on all four sides', () => {
    render(<BlankWithPart blank={BLANK} part={PART} />);
    for (const side of ['left', 'right', 'front', 'back']) {
      expect(screen.getByTestId(`blank-part-margin-${side}`).textContent, side).toBe('5 mm');
    }
    expect(screen.getByTestId('blank-part-footprint').getAttribute('class')).toBe('blank-part');
    expect(screen.queryByTestId('blank-part-overrun')).toBeNull();
  });

  it('a 90 mm part on a 75 mm blank is clipped and the overrun is named', () => {
    render(<BlankWithPart blank={BLANK} part={{ ...PART, length: 90 }} />);
    expect(screen.getByTestId('blank-part-footprint').getAttribute('class')).toContain('blank-part--clipped');
    expect(screen.getByTestId('blank-part-overrun').textContent).toBe('the part is 15 mm longer than the blank');
  });

  it('the margins are one rule, not four fields', () => {
    expect(blankMargins({ length: 75, width: 72.7 }, { length: 65, width: 62.7 })).toMatchObject({
      left: 5,
      right: 5,
      front: 5,
      back: 5,
      overLength: 0,
      overWidth: 0,
    });
    expect(overrunSentence(blankMargins({ length: 75, width: 75 }, { length: 90, width: 60 }))).toBe(
      'the part is 15 mm longer than the blank',
    );
  });
});
