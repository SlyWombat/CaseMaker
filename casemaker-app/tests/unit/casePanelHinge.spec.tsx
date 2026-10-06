// @vitest-environment jsdom
// The panel wiring for the two-screw hinge (#114): the style is offered, and the
// controls the screw's geometry decides are shown but inert. The geometry itself is
// covered by `hinges.spec.ts`; this file proves the panel lets the user choose it.

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { CasePanel } from '@/components/panels/CasePanel';
import { createDefaultProject, useProjectStore } from '@/store/projectStore';
import type { HingeFeature } from '@/types';

function screwHinge(): HingeFeature {
  return {
    id: 'h',
    style: 'hardware-screw',
    face: '-y',
    numKnuckles: 5,
    knuckleOuterDiameter: 8,
    pinDiameter: 3,
    knuckleClearance: 0.4,
    positioning: 'centered',
    hingeLength: 60,
    pinMode: 'separate',
    enabled: true,
  };
}

function seed(hinge?: HingeFeature): void {
  const project = createDefaultProject('rpi-4b');
  project.case.joint = 'screw-down';
  if (hinge) project.case.hinge = hinge;
  useProjectStore.setState({ project });
}

afterEach(cleanup);

describe('CasePanel — the two-screw hinge (#114)', () => {
  it('offers the style in the hinge dropdown', () => {
    seed();
    render(<CasePanel />);
    const select = screen.getByTestId('hinge-style-dropdown');
    expect(within(select).getByRole('option', { name: 'Two screws' })).toBeTruthy();
  });

  it('disables the count, positioning and length controls it does not use, and hides the pin Ø', () => {
    seed(screwHinge());
    render(<CasePanel />);
    // No jest-dom matchers in this suite — read the DOM property.
    expect((screen.getByTestId('hinge-num-knuckles') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('hinge-length') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('hinge-positioning-centered') as HTMLInputElement).disabled).toBe(true);
    // The style closes with M3 screws, not a pin — there is nothing to size.
    expect(screen.queryByTestId('hinge-pin-d')).toBeNull();
  });

  it('leaves every control live on the other styles', () => {
    seed({ ...screwHinge(), style: 'external-pin' });
    render(<CasePanel />);
    expect((screen.getByTestId('hinge-num-knuckles') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId('hinge-length') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId('hinge-positioning-centered') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByTestId('hinge-pin-d')).toBeTruthy();
  });
});
