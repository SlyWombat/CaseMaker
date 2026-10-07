// @vitest-environment jsdom
// Issue #280 — the right rail's drawer state on a compact viewport.
//
// The drawer auto-opens on a *change* of selection/section, which is right for a panel that is
// already on screen. The startup wizard is the first code path that hands the shell a section
// BEFORE this panel mounts, so there was no change to see: at any width under 1366 the user got a
// highlighted rail button and a shut drawer — the #274 "no way in" complaint one step later.
// These pin the mount case, and the two neighbours it must not disturb.

import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ContextPanel } from '@/components/layout/ContextPanel';
import { useViewportStore } from '@/store/viewportStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
}

function panelClass(): string {
  return screen.getByTestId('context-panel').className;
}

beforeEach(() => {
  cleanup();
  useViewportStore.setState({ activeSidebarSection: null, selection: null });
});

describe('#280 — the context panel mounts with a section already active', () => {
  it('opens the drawer — a compact viewport must not hide the panel it was handed', () => {
    setWidth(1024);
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    render(<ContextPanel />);
    expect(panelClass()).toContain('context-panel--drawer');
    expect(panelClass()).toContain('context-panel--open');
  });

  it('stays shut when it mounts with nothing to show', () => {
    setWidth(1024);
    render(<ContextPanel />);
    expect(panelClass()).toContain('context-panel--closed');
    // And the handle still opens it.
    fireEvent.click(screen.getByTestId('context-panel-handle'));
    expect(panelClass()).toContain('context-panel--open');
  });

  it('above the breakpoint it is a plain rail, open, with no handle', () => {
    setWidth(1440);
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    render(<ContextPanel />);
    expect(panelClass()).toContain('context-panel--rail');
    expect(panelClass()).toContain('context-panel--open');
    expect(screen.queryByTestId('context-panel-handle')).toBeNull();
  });
});
