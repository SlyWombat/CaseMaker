// @vitest-environment jsdom
// #1123-48 — HOME KEEPS THE WORK: a Home control, a Continue row back to exactly where the operator
// was, and the app's own dialog (never window.confirm) when a choice would replace open work.
//
// Fields (issue #1123, comment 6778147810): Home first in the toolbar, always present, disabled
// with its reason during a machine run; the main page gains a Continue row naming the open thing
// and when it last changed; New and a card that would replace the project ask once in the app's own
// dialog with an honest sentence.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Toolbar } from '@/components/layout/Toolbar';
import { WelcomeOverlay } from '@/components/welcome/WelcomeOverlay';
import { useProjectStore } from '@/store/projectStore';
import { useManageModeStore } from '@/store/manageModeStore';
import { useViewportStore } from '@/store/viewportStore';
import { useMachineRunStore } from '@/store/machineRunStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveJobFileStore } from '@/store/engraveJobFileStore';
import { markWorkedOn, clearWorkedOn } from '@/store/homeSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
}

beforeEach(() => {
  cleanup();
  setWidth(1280);
  clearWorkedOn();
  useProjectStore.setState({ welcomeMode: false });
  useManageModeStore.getState().closeManage();
  useViewportStore.setState({ activeSidebarSection: null });
  useMachineRunStore.setState({ runs: {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ boards: [] }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearWorkedOn();
});

describe('#1123-48 Home keeps the work', () => {
  it('Home is the toolbar’s first control and shows the main page WITHOUT resetting the project', () => {
    render(<Toolbar />);
    const home = screen.getByTestId('home');
    // First control in the bar.
    expect((home.parentElement?.firstElementChild as HTMLElement | null)?.dataset.testid).toBe('home');
    const projectBefore = useProjectStore.getState().project;
    fireEvent.click(home);
    expect(useProjectStore.getState().welcomeMode).toBe(true);
    expect(useProjectStore.getState().project, 'the open project is untouched').toBe(projectBefore);
  });

  it('Home is disabled during a machine run, and says why', () => {
    useMachineRunStore.setState({ runs: { '192.0.2.10:2222': { running: true } as never } });
    render(<Toolbar />);
    const home = screen.getByTestId('home') as HTMLButtonElement;
    expect(home.disabled).toBe(true);
    expect(home.getAttribute('title')).toContain('a program is running');
  });

  it('New asks in the app’s own dialog — never window.confirm — with an honest sentence', () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    useEngraveJobFileStore.setState({ fileName: 'tray.casejob', savedText: '{}', dirty: false });
    render(<Toolbar />);
    fireEvent.click(screen.getByTestId('new-project'));
    expect(confirm, 'no browser confirm in this path').not.toHaveBeenCalled();
    const dialog = screen.getByTestId('new-project-confirm');
    expect(dialog.textContent).toContain('will be replaced');
    expect(dialog.textContent, 'saved work is not called unsaved').not.toContain('Unsaved changes');
    fireEvent.click(screen.getByTestId('new-project-confirm-no'));
    expect(screen.queryByTestId('new-project-confirm')).toBeNull();
    expect(useProjectStore.getState().welcomeMode).toBe(false);
  });

  it('the main page continues the open CNC job, by name and kind', () => {
    markWorkedOn();
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    useEngraveJobStore.setState({ job: { ...useEngraveJobStore.getState().job, name: 'Tray, side 1' } });
    useEngraveJobFileStore.setState({ savedAt: Date.parse('2026-11-10T20:35:00Z') });
    useProjectStore.setState({ welcomeMode: true });
    render(<WelcomeOverlay />);
    const row = screen.getByTestId('welcome-continue');
    expect(row.textContent).toContain('Tray, side 1');
    expect(row.textContent).toContain('a CNC job');
    fireEvent.click(screen.getByTestId('welcome-continue-open'));
    expect(useProjectStore.getState().welcomeMode, 'Continue returns to the workspace').toBe(false);
  });

  it('a first visit has no Continue row', () => {
    useProjectStore.setState({ welcomeMode: true });
    render(<WelcomeOverlay />);
    expect(screen.queryByTestId('welcome-continue')).toBeNull();
  });

  it('a card that would replace open work asks once, in the app’s dialog', () => {
    markWorkedOn();
    useProjectStore.setState({ welcomeMode: true });
    render(<WelcomeOverlay />);
    // The rack card builds a project; with work open it asks first.
    fireEvent.click(screen.getByTestId('welcome-door-racks'));
    const dialog = screen.getByTestId('welcome-replace-confirm');
    expect(dialog.textContent).toContain('will be replaced');
    fireEvent.click(screen.getByTestId('welcome-replace-confirm-no'));
    expect(screen.queryByTestId('welcome-replace-confirm')).toBeNull();
    expect(useProjectStore.getState().welcomeMode, 'cancel changes nothing').toBe(true);
  });
});
