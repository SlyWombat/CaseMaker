// @vitest-environment jsdom
// Issue #155 — a toolbox project's section rail. A bin and a lid have no board,
// no ports and no shell features, so the eight board-in-a-shell sections drop
// out; the toolbox's own parameters replace them, and Export and the two CNC
// panels stay because they work on any project.

import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/layout/Sidebar';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import { findTemplate } from '@/library/templates';
import { defaultToolboxParams } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The rail's sections, in render order. */
function sectionIds(): string[] {
  return screen
    .getAllByTestId(/^sidebar-button-/)
    .map((el) => el.getAttribute('data-testid')!.replace('sidebar-button-', ''));
}

function enableToolbox(): void {
  const project = createDefaultProject('rpi-4b');
  useProjectStore.setState({
    project: { ...project, case: { ...project.case, toolbox: defaultToolboxParams() } },
  });
}

beforeEach(() => {
  cleanup();
  useProjectStore.setState({ welcomeMode: false });
  useViewportStore.setState({ activeSidebarSection: null, selection: null });
});

describe('#155 — the toolbox project’s rail', () => {
  it('leads with the toolbox section, and drops everything board-shaped', () => {
    enableToolbox();
    render(<Sidebar />);
    expect(sectionIds()).toEqual(['toolbox', 'export', 'cnc-engrave', 'cnc-sim']);
    for (const id of ['board', 'case', 'rack', 'insert', 'ports', 'hats', 'features', 'assets']) {
      expect(screen.queryByTestId(`sidebar-button-${id}`), `${id} should be hidden`).toBeNull();
    }
  });

  it('the template reaches the same rail as a hand-enabled project', () => {
    useProjectStore.getState().setProject(findTemplate('toolbox')!.build());
    render(<Sidebar />);
    expect(sectionIds()).toEqual(['toolbox', 'export', 'cnc-engrave', 'cnc-sim']);
  });

  it('a stale board-shaped section resets to the toolbox panel, not to Export', () => {
    enableToolbox();
    useViewportStore.setState({ activeSidebarSection: 'hats' });
    render(<Sidebar />);
    expect(useViewportStore.getState().activeSidebarSection).toBe('toolbox');
  });

  it('a shell project still keeps every section', () => {
    useProjectStore.getState().setProject(createDefaultProject('rpi-4b'));
    render(<Sidebar />);
    expect(sectionIds()).toContain('toolbox');
    expect(sectionIds()).toContain('board');
  });
});
