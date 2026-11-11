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
  it('leads with Part, then Export, and nothing board-shaped — Job and Simulate are the CNC workspace’s (#1123-59)', () => {
    useProjectStore.getState().setProject(findTemplate('blank')!.build());
    render(<Sidebar />);
    expect(sectionIds()).toEqual(['part', 'export']);
    for (const id of ['board', 'case', 'rack', 'insert', 'ports', 'hats', 'features', 'assets']) {
      expect(screen.queryByTestId(`sidebar-button-${id}`), `${id} should be hidden`).toBeNull();
    }
  });

  it('#726 P1 — the CNC entry is the job; "Cut" is the mode inside it', () => {
    useProjectStore.getState().setProject(findTemplate('blank')!.build());
    // #1123-59 — Job and Simulate are the CNC workspace's rail, entered by "Cut this on the CNC".
    useViewportStore.setState({ workspace: 'cnc' });
    render(<Sidebar />);
    // first-job-flow §4: "Cut" is the mode (Design · Cut), never a rail label — the rail entry
    // opens the job, and the mode switch inside says which half of it is on screen.
    const entry = screen.getByTestId('sidebar-button-cnc-engrave');
    expect(entry.textContent).toContain('Job');
    expect(entry.textContent).not.toContain('Cut');
    expect(screen.getByTestId('sidebar-button-cnc-sim').textContent).toContain('Simulate');
  });

  it('matches the badge’s rail today — the two are separate constants, not one shared list', () => {
    useProjectStore.getState().setProject(findTemplate('badge-blank')!.build());
    render(<Sidebar />);
    expect(sectionIds()).toEqual(['part', 'export']);
  });

  it('a shell project keeps its own sections only (#1123-59): no Part, no other archetype’s editor, no CNC entry', () => {
    useProjectStore.getState().setProject(createDefaultProject('rpi-4b'));
    render(<Sidebar />);
    expect(sectionIds()).toContain('board');
    expect(sectionIds()).toEqual(['board', 'case', 'ports', 'hats', 'features', 'assets', 'export']);
    expect(screen.queryByTestId('sidebar-button-part')).toBeNull();
  });

  it('a stale board-shaped section resets to the part editor, not to Export', () => {
    useProjectStore.getState().setProject(findTemplate('blank')!.build());
    useViewportStore.setState({ activeSidebarSection: 'board' });
    render(<Sidebar />);
    expect(useViewportStore.getState().activeSidebarSection).toBe('part');
  });
});
