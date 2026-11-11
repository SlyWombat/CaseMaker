// @vitest-environment jsdom
// #1123 item 59 — IN A CNC JOB THE LEFT RAIL IS THE CNC WORKSPACE'S, not the case designer's.
//
// Bench 2026-11-10, build f5ffb809 (maintainer): "I don't know where the left menu came from, but
// it makes no sense here." A cutting job opened from a file sits on the default board project, so
// beside Job and Simulate the rail listed Board, Case parameters, Rack, Tool insert, Toolbox, Port
// cutouts, HATs, Features, External assets and Export — none of which belongs to the blank in the
// machine. The fields (item 59): the rail shows the WORKSPACE's sections; in CNC that is the
// machine pin, Job and Simulate alone; the workspace is the app's state, entered by the CNC card,
// by opening a cutting job and by the reload restore; Home is the way to the other workspaces.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('@/platform/features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/features')>();
  return { ...actual, featureSim: true };
});

import { Sidebar } from '@/components/layout/Sidebar';
import { createDefaultProject, useProjectStore } from '@/store/projectStore';
import { findTemplate } from '@/library/templates';
import { useViewportStore } from '@/store/viewportStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CASE_SECTIONS = ['board', 'case', 'rack', 'insert', 'toolbox', 'ports', 'hats', 'features', 'assets', 'export', 'part'];

beforeEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  localStorage.clear();
  useProjectStore.setState({ welcomeMode: false });
  useViewportStore.setState({ activeSidebarSection: null, workspace: 'case', selection: null });
});

describe('#1123-59 the rail follows the workspace', () => {
  it('in the CNC workspace it is the machine pin, Job and Simulate — no case section is rendered', () => {
    useViewportStore.setState({ workspace: 'cnc' });
    render(<Sidebar />);
    expect(screen.getByTestId('sidebar-button-cnc-engrave')).toBeDefined();
    expect(screen.getByTestId('sidebar-button-cnc-sim')).toBeDefined();
    for (const id of CASE_SECTIONS) {
      expect(screen.queryByTestId(`sidebar-button-${id}`), id).toBeNull();
    }
    // The rail's buttons are exactly the two CNC entries (the machine pin is not a section).
    const buttons = [...screen.getByTestId('sidebar').querySelectorAll('button')]
      .map((b) => b.getAttribute('data-testid'))
      .filter((id): id is string => id !== null && id.startsWith('sidebar-button-'))
      .sort();
    expect(buttons).toEqual(['sidebar-button-cnc-engrave', 'sidebar-button-cnc-sim']);
  });

  it('the CNC rail keeps the project’s OWN-PART editor and Export — never the shell’s menu', () => {
    // The analyst's ruling (#1123 comment 6782275435): a blank's corner radius and a part's own
    // geometry are edited ONLY in their own panel, and Export is that project's product.
    const kinds: Array<[string, string[]]> = [
      ['blank', ['part', 'export', 'cnc-engrave', 'cnc-sim']],
      ['badge-blank', ['part', 'export', 'cnc-engrave', 'cnc-sim']],
      ['tool-insert', ['insert', 'export', 'cnc-engrave', 'cnc-sim']],
      ['toolbox', ['toolbox', 'export', 'cnc-engrave', 'cnc-sim']],
      ['mini-rack-10in', ['rack', 'export', 'cnc-engrave', 'cnc-sim']],
    ];
    for (const [template, expected] of kinds) {
      cleanup();
      useProjectStore.setState({ welcomeMode: false });
      useProjectStore.getState().setProject(findTemplate(template)!.build());
      // Opening a project sets the case workspace; the operator enters CNC from the door or a job.
      useViewportStore.setState({ activeSidebarSection: null, workspace: 'cnc', selection: null });
      render(<Sidebar />);
      const ids = [...screen.getByTestId('sidebar').querySelectorAll('button')]
        .map((b) => b.getAttribute('data-testid'))
        .filter((id): id is string => id !== null && id.startsWith('sidebar-button-'))
        .map((id) => id.replace('sidebar-button-', ''));
      expect(ids, template).toEqual(expected);
    }
  });

  it('a BOARD CASE in CNC keeps only the pin, Job and Simulate — no Export', () => {
    // A job opened from a file sits on the placeholder board project; that project's menu is the
    // bench's complaint and its Export is the print product's, so neither is on the CNC rail.
    useProjectStore.setState({ project: createDefaultProject('rpi-4b'), welcomeMode: false });
    useViewportStore.setState({ activeSidebarSection: null, workspace: 'cnc', selection: null });
    render(<Sidebar />);
    const ids = [...screen.getByTestId('sidebar').querySelectorAll('button')]
      .map((b) => b.getAttribute('data-testid'))
      .filter((id): id is string => id !== null && id.startsWith('sidebar-button-'))
      .map((id) => id.replace('sidebar-button-', ''));
    expect(ids).toEqual(['cnc-engrave', 'cnc-sim']);
    expect(screen.queryByTestId('sidebar-button-export')).toBeNull();
  });

  it('a case project keeps its own rail; entering CNC (the door, or "Cut this on the CNC") switches the rail to the CNC list', () => {
    // #1123-59 row 6 — a board case has no Job entry in its design rail; the workspace is entered
    // from the door (or a cuttable project's own "Cut this on the CNC").
    render(<Sidebar />);
    expect(screen.getByTestId('sidebar-button-board')).toBeDefined();
    expect(screen.queryByTestId('sidebar-button-cnc-engrave')).toBeNull();
    act(() => {
      useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
    });
    expect(useViewportStore.getState().workspace).toBe('cnc');
    expect(screen.queryByTestId('sidebar-button-board')).toBeNull();
    expect(screen.getByTestId('sidebar-button-cnc-engrave')).toBeDefined();
  });

  it('opening a case project from the door is the case workspace again', () => {
    useViewportStore.setState({ workspace: 'cnc', activeSidebarSection: 'cnc-engrave' });
    render(<Sidebar />);
    expect(screen.queryByTestId('sidebar-button-board')).toBeNull();
    act(() => {
      useProjectStore.getState().setProject(useProjectStore.getState().project);
    });
    expect(useViewportStore.getState().workspace).toBe('case');
    expect(screen.getByTestId('sidebar-button-board')).toBeDefined();
  });

  it('selecting any section sets the workspace it belongs to, and closing one leaves it', () => {
    const vp = useViewportStore.getState();
    vp.setActiveSidebarSection('cnc-sim');
    expect(useViewportStore.getState().workspace).toBe('cnc');
    vp.setActiveSidebarSection(null);
    expect(useViewportStore.getState().workspace, 'the editor closing is not leaving CNC').toBe('cnc');
    vp.setActiveSidebarSection('features');
    expect(useViewportStore.getState().workspace).toBe('case');
  });

  it('the phone drawer shows the same workspace list', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    useViewportStore.setState({ workspace: 'cnc' });
    render(<Sidebar />);
    expect(screen.getByTestId('sidebar-button-cnc-engrave')).toBeDefined();
    expect(screen.queryByTestId('sidebar-button-board')).toBeNull();
  });
});
