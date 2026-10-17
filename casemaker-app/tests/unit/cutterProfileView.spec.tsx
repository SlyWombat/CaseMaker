// @vitest-environment jsdom
/**
 * The React cutter profile (#489): the component must expose the same links the model carries —
 * a dimension and its field highlight each other, a missing field is dashed with `?`, a refusal is
 * visible with its reason, and the thumbnail has no dimension clutter.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CutterProfile } from '@/components/ui/CutterProfile';
import { CutterProfileFields } from '@/components/ui/CutterProfileFields';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

afterEach(cleanup);

const ENGRAVER: Tool = flatEndMill(3.175, {
  name: '30° engraving bit',
  typeText: 'Engraving',
  shape: 'engraving',
  tipDiameter: 0.3,
  diameter: 3.175,
  halfAngle: 15,
  angle: 30,
  fluteLength: 6,
  shoulderLength: null,
});

const FLAT: Tool = flatEndMill(3.175, {
  name: '3.175 mm flat end',
  fluteLength: 12,
  shoulderLength: null,
});

const UNKNOWN: Tool = flatEndMill(3.175, {
  name: 'mystery bit',
  typeText: 'Laser Wand',
  shape: 'unknown',
});

const dimension = (code: string): SVGGElement => {
  const el = document.querySelector(`[data-dimension="${code}"]`);
  if (el === null) throw new Error(`dimension ${code} not rendered`);
  return el as SVGGElement;
};

describe('CutterProfile (#489)', () => {
  it('renders the shape vocabulary and links every dimension to its field', () => {
    render(<CutterProfile tool={ENGRAVER} />);
    const codes = ['DS', 'DC', 'LC', 'AN', 'D1'];
    expect([...document.querySelectorAll('[data-dimension]')].map((el) => el.getAttribute('data-dimension'))).toEqual(codes);
    expect(dimension('DS').getAttribute('data-field')).toBe('handleDiameter');
    expect(dimension('DC').getAttribute('data-field')).toBe('diameter');
    expect(dimension('LC').getAttribute('data-field')).toBe('fluteLength');
    expect(dimension('AN').getAttribute('data-field')).toBe('halfAngle');
    expect(dimension('D1').getAttribute('data-field')).toBe('tipDiameter');
    expect(dimension('LC').textContent).toContain('LC 6.0');
  });

  it('reports a dimension hover to the field, and a field highlight to the dimension', () => {
    const onFieldHover = vi.fn();
    const { rerender } = render(<CutterProfile tool={ENGRAVER} onFieldHover={onFieldHover} />);

    fireEvent.mouseEnter(dimension('LC'));
    expect(onFieldHover).toHaveBeenCalledWith('fluteLength');
    expect(dimension('LC').classList.contains('is-active')).toBe(true);

    fireEvent.mouseLeave(dimension('LC'));
    expect(onFieldHover).toHaveBeenLastCalledWith(null);
    expect(dimension('LC').classList.contains('is-active')).toBe(false);

    rerender(<CutterProfile tool={ENGRAVER} highlightedField="tipDiameter" onFieldHover={onFieldHover} />);
    expect(dimension('D1').classList.contains('is-active')).toBe(true);
    expect(dimension('LC').classList.contains('is-active')).toBe(false);
  });

  it('links the shank box to the body diameter DC on a V-bit', () => {
    // The editor has no `diameter` box: for an engraver the body IS the shank, and `toolFromSpec`
    // writes `shank ⌀` into both fields. Highlighting either one must light both lines up.
    const { rerender } = render(<CutterProfile tool={ENGRAVER} highlightedField="handleDiameter" />);
    expect(dimension('DS').classList.contains('is-active')).toBe(true);
    expect(dimension('DC').classList.contains('is-active')).toBe(true);
    rerender(<CutterProfile tool={ENGRAVER} highlightedField="diameter" />);
    expect(dimension('DS').classList.contains('is-active')).toBe(true);
    expect(dimension('DC').classList.contains('is-active')).toBe(true);
  });

  it('makes a dimension keyboard-focusable, with an accessible name', () => {
    render(<CutterProfile tool={ENGRAVER} />);
    expect(dimension('D1').getAttribute('tabindex')).toBe('0');
    expect(dimension('D1').getAttribute('aria-label')).toContain('flat tip Ø');
    expect(dimension('D1').getAttribute('aria-label')).toContain('0.3');
  });

  it('highlights the edge that depends on a hovered missing field', () => {
    render(<CutterProfile tool={FLAT} />);
    const ls = dimension('LS');
    expect(ls.textContent).toContain('LS ?');
    expect(ls.classList.contains('is-missing')).toBe(true);
    const line = ls.querySelector('.cutter-profile__path--dimension')!;
    expect(line.getAttribute('data-dashed')).toBe('true');

    fireEvent.mouseEnter(ls);
    const edge = document.querySelector('[data-missing-field="shoulderLength"]');
    expect(edge).not.toBeNull();
    expect(edge!.classList.contains('is-active')).toBe(true);
  });

  it('draws a missing field dashed even when it is not in the shape vocabulary', () => {
    // The engraver's shoulder is not an LS dimension, but the edge still says it is unknown.
    render(<CutterProfile tool={ENGRAVER} />);
    const neck = document.querySelector('[data-missing-field="shoulderLength"]');
    expect(neck).not.toBeNull();
    expect(neck!.classList.contains('is-missing')).toBe(true);
    expect(neck!.getAttribute('data-dashed')).toBe('true');
  });

  it('shows a refusal greyed, with the simulator code and reason', () => {
    render(
      <CutterProfile
        tool={FLAT}
        refusal={{ code: 'prior-removal-column', reason: 'the roughing pass already removed this column' }}
      />,
    );
    expect(screen.getByTestId('cutter-profile').classList.contains('is-refused')).toBe(true);
    const note = screen.getByTestId('cutter-profile-refusal');
    expect(note.textContent).toContain('prior-removal-column');
    expect(note.textContent).toContain('the roughing pass already removed this column');
  });

  it('judges an unknown shape as tool-refused and keeps the drawing', () => {
    render(<CutterProfile tool={UNKNOWN} />);
    expect(screen.getByTestId('cutter-profile').classList.contains('is-refused')).toBe(true);
    expect(screen.getByTestId('cutter-profile-refusal').textContent).toContain('tool-refused');
    expect(document.querySelectorAll('.cutter-profile__path').length).toBeGreaterThan(0);
  });

  it('omits dimensions and scale bars in the thumbnail', () => {
    render(<CutterProfile tool={ENGRAVER} size="thumb" />);
    expect(document.querySelectorAll('[data-dimension]').length).toBe(0);
    expect(screen.queryByTestId('cutter-profile-scale')).toBeNull();
    expect(screen.getByTestId('cutter-profile').classList.contains('cutter-profile--thumb')).toBe(true);
  });

  it('draws the V groove at the job depth', () => {
    render(<CutterProfile tool={ENGRAVER} grooveDepth={1} />);
    const groove = screen.getByTestId('cutter-profile-groove');
    expect(groove.textContent).toContain('Ø 0.836 mm at 1.0 mm deep');
  });

  it('shows scale bars in the full view', () => {
    render(<CutterProfile tool={FLAT} />);
    expect(screen.getByTestId('cutter-profile-scale')).not.toBeNull();
  });

  it('colours the shank band with the owned cutter label colour', () => {
    const { rerender } = render(<CutterProfile tool={FLAT} labelColor="#e05a00" />);
    const band = screen.getByTestId('cutter-profile-label-band');
    expect(band.getAttribute('style')).toMatch(/#e05a00|rgb\(224,\s*90,\s*0\)/);
    rerender(<CutterProfile tool={FLAT} />);
    expect(screen.queryByTestId('cutter-profile-label-band')).toBeNull();
  });

  it('lists every dimension code as a field, including the ones the form has no box for', () => {
    const onFieldHover = vi.fn();
    render(<CutterProfileFields tool={ENGRAVER} onFieldHover={onFieldHover} />);
    const rows = [...document.querySelectorAll('[data-testid="cutter-profile-fields"] [role="listitem"]')];
    expect(rows.map((row) => row.getAttribute('data-dimension'))).toEqual(['DS', 'DC', 'LC', 'AN', 'D1']);
    const row = (code: string) => rows.find((r) => r.getAttribute('data-dimension') === code)!;
    expect(row('DS').textContent).toContain('3.175 mm');
    expect(row('AN').textContent).toContain('15°');
    expect(row('LC').getAttribute('data-field')).toBe('fluteLength');

    fireEvent.mouseEnter(row('LC'));
    expect(onFieldHover).toHaveBeenCalledWith('fluteLength');
    fireEvent.mouseLeave(row('LC'));
    expect(onFieldHover).toHaveBeenLastCalledWith(null);

    fireEvent.focus(row('D1'));
    expect(onFieldHover).toHaveBeenLastCalledWith('tipDiameter');
  });

  it('marks a field row for an outside highlight, and says `? not stated` for a missing one', () => {
    const { rerender } = render(<CutterProfileFields tool={FLAT} highlightedField="shoulderLength" />);
    const row = (code: string) =>
      document.querySelector(`[data-testid="cutter-profile-fields"] [data-dimension="${code}"]`) as HTMLElement;
    expect(row('LS').classList.contains('is-active')).toBe(true);
    expect(row('LS').classList.contains('is-missing')).toBe(true);
    expect(row('LS').textContent).toContain('? not stated');
    // A field outside this shape's vocabulary has no row to mark.
    expect(document.querySelector('[data-testid="cutter-profile-fields"] [data-field="cornerRadius"]')).toBeNull();

    rerender(<CutterProfileFields tool={ENGRAVER} highlightedField="handleDiameter" />);
    expect(row('DC').classList.contains('is-active')).toBe(true);
  });

  it('names and describes the cutter in the SVG for assistive technology', () => {
    render(<CutterProfile tool={ENGRAVER} />);
    const svg = screen.getByRole('img');
    const title = svg.querySelector('title')!;
    const desc = svg.querySelector('desc')!;
    expect(title.textContent).toContain('30° engraving bit');
    expect(title.textContent).toContain('engraving cutter profile');
    expect(desc.textContent).toContain('Side profile');
    expect(desc.textContent).toContain('Shoulder length is not stated');
  });
});
