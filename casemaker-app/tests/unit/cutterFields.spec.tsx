// @vitest-environment jsdom
/**
 * The Type door's boxes carry the profile link (#489): a highlighted field marks its box, and a
 * hovered or focused box reports the field so the drawing can mark the dimension. The boxes are
 * still the same six fields — this test is about the wiring, not a new form.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CutterFields } from '@/components/manage/doors/CutterFields';
import type { CutterSpec } from '@/engine/cnc/registerCutter';

afterEach(cleanup);

const SPEC: CutterSpec = {
  name: '3.175 mm flat end',
  shape: 'flat',
  tipDiameter: '3.175',
  handleDiameter: '3.175',
  fluteLength: '12',
  shoulderLength: '',
};

function labelFor(prefix: string, suffix: string): HTMLElement {
  const input = document.querySelector(`[data-testid="${prefix}-${suffix}"]`);
  if (input === null) throw new Error(`${suffix} input not rendered`);
  return input.closest('label') as HTMLElement;
}

describe('CutterFields (#489)', () => {
  it('marks the box of a highlighted field and reports hover and focus', () => {
    const onHighlight = vi.fn();
    const { rerender } = render(
      <CutterFields prefix="t" spec={SPEC} onChange={() => {}} disabled={false} highlight="fluteLength" onHighlight={onHighlight} />,
    );

    expect(labelFor('t', 'flute').classList.contains('is-active')).toBe(true);
    expect(labelFor('t', 'tip').classList.contains('is-active')).toBe(false);

    fireEvent.mouseEnter(labelFor('t', 'shoulder'));
    expect(onHighlight).toHaveBeenCalledWith('shoulderLength');
    fireEvent.mouseLeave(labelFor('t', 'shoulder'));
    expect(onHighlight).toHaveBeenLastCalledWith(null);

    fireEvent.focus(labelFor('t', 'tip'));
    expect(onHighlight).toHaveBeenLastCalledWith('tipDiameter');
    fireEvent.blur(labelFor('t', 'tip'));
    expect(onHighlight).toHaveBeenLastCalledWith(null);

    // The shank box is the body diameter on a V-bit; the profile reports `diameter` for DC and the
    // box must still light up.
    rerender(
      <CutterFields prefix="t" spec={SPEC} onChange={() => {}} disabled={false} highlight="diameter" onHighlight={onHighlight} />,
    );
    expect(labelFor('t', 'shank').classList.contains('is-active')).toBe(true);
  });

  it('does not mark the name or the shape: they are not dimensions', () => {
    render(<CutterFields prefix="t" spec={SPEC} onChange={() => {}} disabled={false} highlight="handleDiameter" />);
    expect(labelFor('t', 'name').classList.contains('is-active')).toBe(false);
    expect(labelFor('t', 'shape').classList.contains('is-active')).toBe(false);
    expect(labelFor('t', 'shank').classList.contains('is-active')).toBe(true);
  });
});
