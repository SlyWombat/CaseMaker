// @vitest-environment jsdom
// Issue #134 — the left section rail is a fixed 320px column on desktop and an
// off-canvas drawer on phones. At 390px the column left the viewport a ~70px
// sliver, so the rail must leave the grid and hide behind a handle instead.

import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/layout/Sidebar';
import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
}

beforeEach(() => {
  cleanup();
  setWidth(1280);
  useProjectStore.setState({ welcomeMode: false });
  useViewportStore.setState({ activeSidebarSection: null, selection: null });
});

const sidebarClass = () => screen.getByTestId('sidebar').className;

describe('the section rail at phone width (#134)', () => {
  it('is an off-canvas drawer with a handle, not a fixed column', () => {
    setWidth(390);
    render(<Sidebar />);
    expect(screen.getByTestId('sidebar-handle')).toBeDefined();
    expect(sidebarClass()).toContain('sidebar--drawer');
    expect(sidebarClass()).toContain('sidebar--closed');
  });

  it('the handle opens and closes it', () => {
    setWidth(390);
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId('sidebar-handle'));
    expect(sidebarClass()).toContain('sidebar--open');
    fireEvent.click(screen.getByTestId('sidebar-handle'));
    expect(sidebarClass()).toContain('sidebar--closed');
  });

  it('picking a section opens its editor and puts the rail away', () => {
    setWidth(390);
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId('sidebar-handle'));
    fireEvent.click(screen.getByTestId('sidebar-button-case'));
    expect(useViewportStore.getState().activeSidebarSection).toBe('case');
    // The right rail auto-opens on that change; leaving the left one up would bury it.
    expect(sidebarClass()).toContain('sidebar--closed');
  });

  it('grows into the drawer when the window is resized down', () => {
    render(<Sidebar />);
    expect(screen.queryByTestId('sidebar-handle')).toBeNull();
    setWidth(390);
    fireEvent(window, new Event('resize'));
    expect(screen.getByTestId('sidebar-handle')).toBeDefined();
    expect(sidebarClass()).toContain('sidebar--drawer');
  });
});

describe('the section rail above the breakpoint', () => {
  it('is a plain in-grid rail with no handle', () => {
    setWidth(1280);
    render(<Sidebar />);
    expect(screen.queryByTestId('sidebar-handle')).toBeNull();
    expect(sidebarClass()).not.toContain('sidebar--drawer');
  });

  it('still toggles the active section off when clicked twice', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId('sidebar-button-case'));
    expect(useViewportStore.getState().activeSidebarSection).toBe('case');
    fireEvent.click(screen.getByTestId('sidebar-button-case'));
    expect(useViewportStore.getState().activeSidebarSection).toBeNull();
  });
});
