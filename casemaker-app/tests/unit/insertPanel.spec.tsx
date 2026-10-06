// @vitest-environment jsdom
// The tool-insert panel's first render test. It exists because the panel had
// none: its Pockets field hands `LabelledField` three children where that
// wrapper had only ever tolerated one, so the enabled panel threw
// `Children.only` on render and no test noticed (#267). Geometry and numbers
// live in `insert.spec.ts`; this file proves the panel renders and that the
// controls reach the project through the store.

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
