// @vitest-environment jsdom
// #1123-47 — the left rail collapses to its icons, with a persisted per-browser state.
//
// Bench, 2026-11-10: "the left menu does not need to be shown most of the time and it can collapse
// to just the icons (it should have a collapse expand capability)". Fields: a chevron at the rail's
// top edge (aria-expanded, keyboard-reachable), a ~48 px icon rail with each section's icon alone
// (label + hint as tooltip and accessible name), the machine pin as its state dot (click expands),
// expanded by default, phone drawer unchanged, display state only.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/platform/features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/features')>();
  return { ...actual, featureSim: true };
});

import { Sidebar } from '@/components/layout/Sidebar';
import { SIDEBAR_LS_KEY } from '@/components/layout/useSidebarCollapsed';
import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
}

beforeEach(() => {
  cleanup();
  setWidth(1280);
  localStorage.removeItem(SIDEBAR_LS_KEY);
  useProjectStore.setState({ welcomeMode: false });
  useViewportStore.setState({ activeSidebarSection: null, selection: null });
});

const rail = () => screen.getByTestId('sidebar');

describe('#1123-47 the left rail collapses to its icons', () => {
  it('starts expanded with a labelled chevron, and collapsing keeps every section reachable', () => {
    render(<Sidebar />);
    const control = screen.getByTestId('sidebar-collapse');
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(control.getAttribute('aria-label')).toBe('Collapse the sections');
    // Expanded: the labels are on the buttons.
    const caseButton = screen.getByTestId('sidebar-button-case');
    expect(caseButton.textContent).toContain('Case parameters');

    fireEvent.click(control);
    // Collapsed: the icon rail class, the control says Expand, and the label is the accessible
    // name + tooltip rather than a text node.
    expect(rail().className).toContain('sidebar--icons');
    expect(screen.getByTestId('sidebar-collapse').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('sidebar-collapse').getAttribute('aria-label')).toBe('Expand the sections');
    const iconButton = screen.getByTestId('sidebar-button-case');
    expect(iconButton.textContent).not.toContain('Case parameters');
    expect(iconButton.getAttribute('aria-label')).toContain('Case parameters');
    expect(iconButton.getAttribute('title')).toBeTruthy();
    // One click still opens the section's editor exactly as expanded.
    fireEvent.click(iconButton);
    expect(useViewportStore.getState().activeSidebarSection).toBe('case');
    // And the choice is the operator's: persisted per browser.
    expect(localStorage.getItem(SIDEBAR_LS_KEY)).toBe('true');
  });

  it('remembers the collapsed state on the next render', () => {
    localStorage.setItem(SIDEBAR_LS_KEY, 'true');
    render(<Sidebar />);
    expect(rail().className).toContain('sidebar--icons');
    expect(screen.getByTestId('sidebar-collapse').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('sidebar-collapse'));
    expect(rail().className).not.toContain('sidebar--icons');
    expect(localStorage.getItem(SIDEBAR_LS_KEY)).toBe('false');
  });

  it('collapsed, the machine pin is its state dot; clicking it expands the rail', () => {
    localStorage.setItem(SIDEBAR_LS_KEY, 'true');
    render(<Sidebar />);
    const pin = screen.getByTestId('machine-pin-collapsed');
    // The dot carries the state and the whole pin text is its tooltip and accessible name.
    expect(pin.getAttribute('title')).toContain('No machine yet');
    expect(pin.getAttribute('aria-label')).toContain('No machine yet');
    fireEvent.click(pin);
    expect(rail().className).not.toContain('sidebar--icons');
    expect(localStorage.getItem(SIDEBAR_LS_KEY)).toBe('false');
  });

  it('two readers — the rail and the shell that sizes the column — share one collapse state', () => {
    // #1123-47 e2e review: AppShell sets `--sidebar-width` from its own call of the hook while the
    // rail paints from another. One external store, so a write in either reaches both.
    render(
      <>
        <Sidebar />
        <Sidebar />
      </>,
    );
    fireEvent.click(screen.getAllByTestId('sidebar-collapse')[0]!);
    for (const railEl of screen.getAllByTestId('sidebar')) {
      expect(railEl.className).toContain('sidebar--icons');
    }
    expect(screen.getAllByTestId('sidebar-collapse')[1]!.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getAllByTestId('machine-pin-collapsed')[1]!);
    for (const railEl of screen.getAllByTestId('sidebar')) {
      expect(railEl.className).not.toContain('sidebar--icons');
    }
  });

  it('the phone drawer keeps its own handle and has no collapse control', () => {
    setWidth(390);
    render(<Sidebar />);
    expect(screen.queryByTestId('sidebar-collapse')).toBeNull();
    expect(screen.getByTestId('sidebar-handle')).toBeDefined();
    expect(rail().className).toContain('sidebar--drawer');
  });
});
