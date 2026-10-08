// @vitest-environment jsdom
// Issue #280 — a blank project's section rail. The blank is the thing the engrave editor drives
// and nothing else, so the rail keeps Export and the two CNC panels and drops the eight sections
// that all assume a board in a shell.

import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/layout/Sidebar';
import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import { findTemplate } from '@/library/templates';
import { createDefaultProject } from '@/store/projectStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The rail's sections, in render order. */
function sectionIds(): string[] {
  return screen
    .getAllByTestId(/^sidebar-button-/)
    .map((el) => el.getAttribute('data-testid')!.replace('sidebar-button-', ''));
}

beforeEach(() => {
  cleanup();
  useProjectStore.setState({ welcomeMode: false });
  useViewportStore.setState({ activeSidebarSection: null, selection: null });
});

describe('#280 — the blank project’s rail', () => {
  // #282 leads the rail with the Part section, where the blank's own size, thickness and corner
  // radius are edited — the last of which had no route to it at all before that panel existed.
  it('leads with Part, then Export and the two CNC panels, and nothing board-shaped', () => {
    useProjectStore.getState().setProject(findTemplate('blank')!.build());
    render(<Sidebar />);
    expect(sectionIds()).toEqual(['part', 'export', 'cnc-engrave', 'cnc-sim']);
    for (const id of ['board', 'case', 'rack', 'insert', 'ports', 'hats', 'features', 'assets']) {
      expect(screen.queryByTestId(`sidebar-button-${id}`), `${id} should be hidden`).toBeNull();
    }
  });

  it('matches the badge’s rail today — the two are separate constants, not one shared list', () => {
    useProjectStore.getState().setProject(findTemplate('badge-blank')!.build());
    render(<Sidebar />);
    expect(sectionIds()).toEqual(['part', 'export', 'cnc-engrave', 'cnc-sim']);
  });

  it('a shell project keeps every section but Part, which edits a part it does not have', () => {
    useProjectStore.getState().setProject(createDefaultProject('rpi-4b'));
    render(<Sidebar />);
    expect(sectionIds()).toContain('board');
    expect(sectionIds()).toHaveLength(12);
    expect(screen.queryByTestId('sidebar-button-part')).toBeNull();
  });

  it('a stale board-shaped section resets to the part editor, not to Export', () => {
    useProjectStore.getState().setProject(findTemplate('blank')!.build());
    useViewportStore.setState({ activeSidebarSection: 'board' });
    render(<Sidebar />);
    expect(useViewportStore.getState().activeSidebarSection).toBe('part');
  });
});
