// @vitest-environment jsdom
// The tool-insert panel's first render test. It exists because the panel had
// none: its Pockets field hands `LabelledField` three children where that
// wrapper had only ever tolerated one, so the enabled panel threw
// `Children.only` on render and no test noticed (#267). Geometry and numbers
// live in `insert.spec.ts`; this file proves the panel renders and that the
// controls reach the project through the store.

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InsertPanel } from '@/components/panels/InsertPanel';
import { defaultInsert } from '@/engine/compiler/insert';
import { createDefaultProject, useProjectStore } from '@/store/projectStore';
import type { InsertParams } from '@/types';

function seed(insert: InsertParams): void {
  const project = createDefaultProject('rpi-4b');
  useProjectStore.setState({ project: { ...project, case: { ...project.case, insert } } });
}

afterEach(cleanup);

describe('InsertPanel (#267)', () => {
  it('renders the whole editor for an enabled insert, Pockets field included', () => {
    seed(defaultInsert());
    render(<InsertPanel />);
    expect(screen.getByTestId('insert-panel')).toBeTruthy();
    // The multi-child field is the one that used to take the panel down — it
    // renders its summary AND its rows AND its add buttons.
    expect(screen.getByTestId('insert-summary')).toBeTruthy();
    expect(screen.getByTestId('insert-item-0')).toBeTruthy();
    expect(screen.getByTestId('insert-add-round')).toBeTruthy();
  });
});

// Issue #262, item 2 — the retention control. The geometry and the numbers are
// `insert.spec.ts`'s; this proves the panel puts them on screen and writes the
// choice back to the project.
describe('InsertPanel — magnet retention (#262)', () => {
  it('starts at friction, with no disc to choose and no magnet budget to report', () => {
    seed(defaultInsert());
    render(<InsertPanel />);
    expect((screen.getByTestId('insert-retention') as HTMLSelectElement).value).toBe('friction');
    expect(screen.queryByTestId('insert-magnet-size')).toBeNull();
    expect(screen.queryByTestId('insert-magnet-needs')).toBeNull();
  });

  it('shows the disc and the plate it needs, and says the default plate is short', () => {
    seed({ ...defaultInsert(), retention: 'magnet' });
    render(<InsertPanel />);
    expect(screen.getByTestId('insert-magnet-size')).toBeTruthy();
    // 4.5 mm pocket + 2.4 mm disc + 1 mm web = 7.9, against a 6 mm plate.
    expect(screen.getByTestId('insert-magnet-needs').textContent).toContain('7.9 mm');
    expect(screen.getByTestId('insert-problem').textContent).toContain('needs a 7.9 mm plate');
  });

  it('writes the retention and the disc to the project', () => {
    seed(defaultInsert());
    render(<InsertPanel />);
    fireEvent.change(screen.getByTestId('insert-retention'), { target: { value: 'magnet' } });
    expect(useProjectStore.getState().project.case.insert?.retention).toBe('magnet');
    fireEvent.change(screen.getByTestId('insert-magnet-size'), { target: { value: '8x3' } });
    expect(useProjectStore.getState().project.case.insert?.magnetSize).toBe('8x3');
  });
});
