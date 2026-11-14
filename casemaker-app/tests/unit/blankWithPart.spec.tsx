// @vitest-environment jsdom
// #1099 — the part on the blank: one footprint, four margins, and a clipped warning when the part
// no longer fits.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { BlankWithPart, blankMargins, overrunSentence } from '@/components/welcome/BlankWithPart';
import { partFootprintFor } from '@/components/welcome/workShape';
import type { WorkShape } from '@/engine/cnc/stockProposal';

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

  it('the "Hello" sign: a blank stated to 0.1 mm and a part to 0.01 mm read 5 mm on every side (#1263)', () => {
    // The proposal rounds the blank to 0.1 (40.27 → 40.3, 20.11 → 20.1); the margins are really 5.015 and
    // 4.995, and the picture prints them at the precision the blank is stated in. The part is centred.
    render(<BlankWithPart blank={{ length: 40.3, width: 20.1, thickness: 1.5 }} part={{ kind: 'text', length: 30.27, width: 10.11, height: 0.5 } as never} />);
    for (const side of ['left', 'right', 'front', 'back']) {
      expect(screen.getByTestId(`blank-part-margin-${side}`).textContent, side).toBe('5 mm');
    }
  });

  it('a 90 mm part on a 75 mm blank is clipped and the overrun is named', () => {
    render(<BlankWithPart blank={BLANK} part={{ ...PART, length: 90 }} />);
    expect(screen.getByTestId('blank-part-footprint').getAttribute('class')).toContain('blank-part--clipped');
    expect(screen.getByTestId('blank-part-overrun').textContent).toBe('the part is 15 mm longer than the blank');
  });

  // #1099 item 1 — the presets draw as the part: a drawing, a cut-out and a pocket each answer a
  // footprint from the size the question already measured. A circle is its diameter both ways.
  it('an outline, a cut-out and a pocket work shape each have a footprint', () => {
    const outline: WorkShape = { kind: 'outline', length: 60, width: 40, through: true };
    const cutout: WorkShape = { kind: 'cutout', length: 36, width: 36 };
    const pocket: WorkShape = { kind: 'pocket', length: 60, width: 40, depth: 6 };
    expect(partFootprintFor(outline)).toEqual({ kind: 'outline', length: 60, width: 40, height: null });
    expect(partFootprintFor(cutout)).toEqual({ kind: 'cutout', length: 36, width: 36, height: null });
    expect(partFootprintFor(pocket)).toEqual({ kind: 'pocket', length: 60, width: 40, height: null });
  });

  // #1099 item 5 — the part's height is drawn down FROM the blank's top, and the skin under it is
  // dimensioned: 20.1 mm blank, 19.1 mm part → 1 mm under it.
  it('20.1 mm blank, 19.1 mm part: the side strip states 1 mm under it', () => {
    render(<BlankWithPart blank={BLANK} part={PART} />);
    const blank = screen.getByTestId('blank-with-part-side-blank');
    const work = screen.getByTestId('blank-with-part-side-work');
    expect(Number(work.getAttribute('y'))).toBeCloseTo(Number(blank.getAttribute('y')), 6);
    expect(Number(work.getAttribute('y')) + Number(work.getAttribute('height'))).toBeLessThanOrEqual(
      Number(blank.getAttribute('y')) + Number(blank.getAttribute('height')) + 0.001,
    );
    expect(screen.getByTestId('blank-with-part-side-skin').textContent).toBe('1 mm under it');
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
