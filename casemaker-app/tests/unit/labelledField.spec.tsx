// @vitest-environment jsdom
// `LabelledField`'s child handling (#89, #267, #150).
//
// The wrapper decorates its child with an id, a title and an aria-describedby
// — but only when there is exactly ONE child, because it has no way to know
// which of several inputs a single label should point at. The interesting part
// is what "exactly one" means, and it has been got wrong twice: `Children.only`
// threw on everything that was not one element, and `Children.count(...) === 1`
// let arrays through, since count traverses them and only does not. This spec
// pins the shapes panels actually pass.

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LabelledField } from '@/components/ui/LabelledField';

afterEach(cleanup);

describe('LabelledField child handling', () => {
  it('decorates a single input with the hint and associates the label', () => {
    render(
      <LabelledField label="Width" hint="How wide it is">
        <input data-testid="field" />
      </LabelledField>,
    );

    const input = screen.getByTestId('field');
    expect(input.getAttribute('title')).toBe('How wide it is');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    // The visible label points at the input it decorates.
    expect(screen.getByText('Width').closest('label')?.htmlFor).toBe(input.id);
  });

  it('leaves several children alone, because one label cannot point at all of them', () => {
    render(
      <LabelledField label="Pockets" hint="Cut into the wall">
        <p>a summary line</p>
        <input data-testid="field" />
      </LabelledField>,
    );

    expect(screen.getByText('a summary line')).toBeTruthy();
    expect(screen.getByTestId('field').getAttribute('title')).toBeNull();
  });

  it('renders an empty list beside a sibling — the shape that took the panel down', () => {
    // A `.map()` over nothing is an empty array, which `Children.count` does
    // not count, so the guard read "[div, []]" as one child and called
    // `Children.only` on an array. The toolbox panel's Dividers field is this
    // shape whenever no divider exists yet.
    const dividers: string[] = [];
    render(
      <LabelledField label="Dividers" hint="Drop-in walls">
        <button type="button">Add divider</button>
        {dividers.map((id) => (
          <span key={id}>divider {id}</span>
        ))}
      </LabelledField>,
    );

    // Flattening leaves one element, so it takes the decoration the same way a
    // lone `<div>` child does (the Footprint field). Harmless — the button
    // gains a hover tooltip — and never a throw, which is the point.
    expect(screen.getByText('Add divider').getAttribute('title')).toBe('Drop-in walls');
  });

  it('renders a list holding exactly one element', () => {
    const dividers = ['1'];
    render(
      <LabelledField label="Dividers" hint="Drop-in walls">
        <button type="button">Add divider</button>
        {dividers.map((id) => (
          <span key={id}>divider {id}</span>
        ))}
      </LabelledField>,
    );

    // Two things are rendered, so nothing is decorated: which of them would a
    // single `htmlFor` mean?
    expect(screen.getByText('Add divider')).toBeTruthy();
    expect(screen.getByText('divider 1')).toBeTruthy();
  });
});
