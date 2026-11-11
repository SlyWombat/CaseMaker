// @vitest-environment jsdom
// #1123 item 59 field 2, as the analyst ruled it on the land18 walk (row 6, comment 6786069667).
//
// A DESIGN workspace (case, rack, tool insert, toolbox, a part) shows NO Job and NO Simulate. A
// project that can be cut (Part / Rack / Tool insert / Toolbox) ends its rail with ONE action,
// "Cut this on the CNC", which enters the CNC workspace for that project (where the amended field 1
// rail applies). A board-case project has no such entry. And a rail lists only the open project's
// OWN archetype's sections: the board case showing Mini rack / Tool insert / Toolbox is a defect.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/platform/features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/features')>();
  return { ...actual, featureSim: true };
});

import { Sidebar } from '@/components/layout/Sidebar';
import { createDefaultProject, useProjectStore } from '@/store/projectStore';
import { findTemplate } from '@/library/templates';
import { useViewportStore } from '@/store/viewportStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const railIds = (): string[] =>
  [...screen.getByTestId('sidebar').querySelectorAll('button')]
    .map((b) => b.getAttribute('data-testid'))
    .filter((id): id is string => id !== null && id.startsWith('sidebar-button-'))
    .map((id) => id.replace('sidebar-button-', ''));

beforeEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  localStorage.clear();
  useProjectStore.setState({ welcomeMode: false });
  useViewportStore.setState({ activeSidebarSection: null, workspace: 'case', selection: null });
});

describe('#1123-59 the design rails', () => {
  it('a board case lists its own sections only: no Job, no Simulate, no other archetype’s editor, no cut entry', () => {
    useProjectStore.setState({ project: createDefaultProject('rpi-4b'), welcomeMode: false });
    render(<Sidebar />);
    expect(railIds()).toEqual(['board', 'case', 'ports', 'hats', 'features', 'assets', 'export']);
    expect(screen.queryByTestId('sidebar-cut-on-cnc')).toBeNull();
  });

  it('each cuttable archetype: its own editor, Export, and "Cut this on the CNC" last — no Job, no Simulate', () => {
    const kinds: Array<[string, string[]]> = [
      ['blank', ['part', 'export']],
      ['badge-blank', ['part', 'export']],
      ['tool-insert', ['insert', 'export']],
      ['toolbox', ['toolbox', 'export']],
      ['mini-rack-10in', ['rack', 'export']],
    ];
    for (const [template, expected] of kinds) {
      cleanup();
      useProjectStore.setState({ welcomeMode: false });
      useProjectStore.getState().setProject(findTemplate(template)!.build());
      useViewportStore.setState({ activeSidebarSection: null, workspace: 'case', selection: null });
      render(<Sidebar />);
      expect(railIds(), template).toEqual(expected);
      const buttons = [...screen.getByTestId('sidebar').querySelectorAll('button')];
      const cut = screen.getByTestId('sidebar-cut-on-cnc');
      expect(cut.textContent, template).toContain('Cut this on the CNC');
      expect(buttons[buttons.length - 1], `${template}: the cut entry is the rail's last`).toBe(cut);
    }
  });

  it('pressing "Cut this on the CNC" lands on the CNC rail for that project', () => {
    useProjectStore.getState().setProject(findTemplate('toolbox')!.build());
    useViewportStore.setState({ activeSidebarSection: null, workspace: 'case', selection: null });
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId('sidebar-cut-on-cnc'));
    expect(useViewportStore.getState().workspace).toBe('cnc');
    expect(railIds()).toEqual(['toolbox', 'export', 'cnc-engrave', 'cnc-sim']);
    expect(screen.queryByTestId('sidebar-cut-on-cnc'), 'in the CNC workspace the door is behind you').toBeNull();
  });
});
