// @vitest-environment jsdom
// Issue #134 — below 640px the header toolbar collapsed its secondary controls
// (New / Save as / Load / Export / Parts / Docs / settings) behind a silent
// horizontal swipe: 848px of content in a 390px scroll container. They must be
// reachable from a ⋯ overflow menu instead, while the desktop bar is unchanged.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Toolbar } from '@/components/layout/Toolbar';
import { useProjectStore } from '@/store/projectStore';
import { useManageModeStore } from '@/store/manageModeStore';
import { useViewportStore } from '@/store/viewportStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
}

beforeEach(() => {
  cleanup();
  setWidth(1280);
  useProjectStore.setState({ welcomeMode: false });
  useManageModeStore.getState().closeManage();
  useViewportStore.setState({ activeSidebarSection: null });
});

const q = (id: string) => screen.queryByTestId(id);

describe('the header toolbar above the breakpoint', () => {
  it('keeps every control inline with no ⋯ toggle', () => {
    render(<Toolbar />);
    for (const id of [
      'new-project',
      'undo-btn',
      'redo-btn',
      'save-project',
      'load-project',
      'export-default',
      'parts-menu-toggle',
      'docs-open',
      'settings-open',
    ]) {
      expect(q(id), id).not.toBeNull();
    }
    expect(q('toolbar-overflow-toggle')).toBeNull();
  });
});

describe('the header toolbar at phone width (#134)', () => {
  it('keeps the primary controls inline and hides the rest', () => {
    setWidth(390);
    render(<Toolbar />);
    for (const id of ['undo-btn', 'redo-btn', 'save-project', 'parts-menu-toggle']) {
      expect(q(id), id).not.toBeNull();
    }
    // These are the controls the old bar pushed off-screen behind a swipe.
    for (const id of ['new-project', 'load-project', 'export-default', 'docs-open', 'settings-open']) {
      expect(q(id), id).toBeNull();
    }
    expect(q('toolbar-overflow-toggle')).not.toBeNull();
  });

  it('the ⋯ menu reveals New / Load / Export / Docs / settings', () => {
    setWidth(390);
    render(<Toolbar />);
    expect(q('toolbar-overflow-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('toolbar-overflow-toggle'));
    expect(q('toolbar-overflow-panel')).not.toBeNull();
    for (const id of ['new-project', 'load-project', 'export-default', 'docs-open', 'settings-open']) {
      expect(q(id), id).not.toBeNull();
    }
  });

  it('an outside tap dismisses the ⋯ menu', () => {
    setWidth(390);
    render(<Toolbar />);
    fireEvent.click(screen.getByTestId('toolbar-overflow-toggle'));
    expect(q('toolbar-overflow-panel')).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(q('toolbar-overflow-panel')).toBeNull();
  });

  it('choosing a command dismisses the menu (#503)', () => {
    setWidth(390);
    render(<Toolbar />);
    fireEvent.click(screen.getByTestId('toolbar-overflow-toggle'));
    expect(q('toolbar-overflow-panel')).not.toBeNull();

    // Manage used to leave the menu open over the rail it opened (#503). The outside-tap handler
    // cannot see this click: the button is INSIDE the ref it tests, so the panel has to close on
    // the command itself.
    fireEvent.click(screen.getByTestId('manage-open'));
    expect(q('toolbar-overflow-panel')).toBeNull();
    expect(useManageModeStore.getState().open).toBe(true);
  });

  it('opening settings from the menu closes the menu and shows the dialog', () => {
    setWidth(390);
    render(<Toolbar />);
    fireEvent.click(screen.getByTestId('toolbar-overflow-toggle'));
    fireEvent.click(screen.getByTestId('settings-open'));
    expect(q('toolbar-overflow-panel')).toBeNull();
    expect(q('settings-menu')).not.toBeNull();
  });

  it('switches layout when the window is resized down', () => {
    render(<Toolbar />);
    expect(q('toolbar-overflow-toggle')).toBeNull();
    setWidth(390);
    fireEvent(window, new Event('resize'));
    expect(q('toolbar-overflow-toggle')).not.toBeNull();
    expect(q('new-project')).toBeNull();
  });
});

// #686 — the toolbar's New / Save / Save as / Load / Export belong to the PRINT project. On a CNC
// page they would write or replace a case that has nothing to do with the job on screen, so they
// are hidden there while Undo/Redo, Manage, Parts, Docs and settings stay. Both directions are
// asserted: absent on the CNC page, present and working on a print section.
describe('the header toolbar hides the print project’s file actions on a CNC page (#686)', () => {
  const PRINT_ONLY = ['new-project', 'save-project', 'save-project-as', 'load-project', 'export-default'];
  const CHROME = ['undo-btn', 'redo-btn', 'manage-open', 'parts-menu-toggle', 'docs-open', 'settings-open'];

  /** `Save as` only exists when the File System Access pickers do; jsdom has neither, so a test
   *  about its presence has to stub both or the assertion proves nothing. */
  function withPickers(): void {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, writable: true, value: vi.fn() });
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, writable: true, value: vi.fn() });
  }

  afterEach(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });

  it.each(['cnc-engrave', 'cnc-sim'] as const)('hides them on %s and keeps the app chrome', (section) => {
    withPickers();
    useViewportStore.setState({ activeSidebarSection: section });
    render(<Toolbar />);
    for (const id of PRINT_ONLY) expect(q(id), id).toBeNull();
    for (const id of CHROME) expect(q(id), id).not.toBeNull();
  });

  it('keeps them, working, on a print project’s section', () => {
    withPickers();
    useViewportStore.setState({ activeSidebarSection: 'case' });
    render(<Toolbar />);
    for (const id of PRINT_ONLY) expect(q(id), id).not.toBeNull();

    // New is the one that needs no picker: it asks, then leaves the project behind (#311).
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByTestId('new-project'));
    expect(confirm).toHaveBeenCalled();
    expect(useProjectStore.getState().welcomeMode).toBe(true);
    confirm.mockRestore();
  });

  it('also hides them from the phone-width ⋯ menu, which keeps the rest', () => {
    withPickers();
    setWidth(390);
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    render(<Toolbar />);
    // The inline Save goes with the rest on a CNC page; the ⋯ toggle stays for the chrome.
    expect(q('save-project')).toBeNull();
    fireEvent.click(screen.getByTestId('toolbar-overflow-toggle'));
    for (const id of PRINT_ONLY) expect(q(id), id).toBeNull();
    for (const id of ['manage-open', 'docs-open', 'settings-open']) expect(q(id), id).not.toBeNull();
  });

  it('the phone-width menu on a print section still offers them', () => {
    withPickers();
    setWidth(390);
    render(<Toolbar />);
    fireEvent.click(screen.getByTestId('toolbar-overflow-toggle'));
    for (const id of ['new-project', 'save-project-as', 'load-project', 'export-default']) {
      expect(q(id), id).not.toBeNull();
    }
  });
});
