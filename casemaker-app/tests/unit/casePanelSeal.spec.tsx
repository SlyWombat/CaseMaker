// @vitest-environment jsdom
// The panel wiring for the gasket clamp (#264): the seal section tells the user
// what the channel will actually be. The numbers and the geometry are covered by
// `seal.spec.ts`; this file proves the panel puts them on screen.

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CasePanel } from '@/components/panels/CasePanel';
import { createDefaultProject, useProjectStore } from '@/store/projectStore';
import type { CaseParameters } from '@/types';

function seed(over: Partial<CaseParameters>): void {
  const project = createDefaultProject('rpi-4b');
  useProjectStore.setState({
    project: {
      ...project,
      case: {
        ...project.case,
        seal: {
          enabled: true,
          profile: 'flat',
          width: 4,
          depth: 2,
          compressionFactor: 0.25,
          gasketMaterial: 'tpu',
        },
        ...over,
      },
    },
  });
}

afterEach(cleanup);

describe('CasePanel — the gasket the wall can hold (#264)', () => {
  it('says what the channel was clamped to when the gasket is wider than the wall', () => {
    seed({ wallThickness: 2 });
    render(<CasePanel />);
    const note = screen.getByTestId('seal-fit-note');
    expect(note.textContent).toContain('does not fit a 2 mm wall');
    expect(note.textContent).toContain('1.20 mm wide');
    expect(note.textContent).toContain('Raise Wall thickness to 4.8 mm');
  });

  it('says nothing when the gasket fits the wall as asked', () => {
    seed({ wallThickness: 5 });
    render(<CasePanel />);
    expect(screen.queryByTestId('seal-fit-note')).toBeNull();
  });

  it('says there is no channel at all when the wall is thinner than its two webs', () => {
    seed({ wallThickness: 1 });
    render(<CasePanel />);
    expect(screen.getByTestId('seal-fit-note').textContent).toContain('No channel is cut');
  });
});
