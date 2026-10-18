// @vitest-environment jsdom
// Issue #280 — the right rail's drawer state on a compact viewport.
//
// The drawer auto-opens on a *change* of selection/section, which is right for a panel that is
// already on screen. The startup wizard is the first code path that hands the shell a section
// BEFORE this panel mounts, so there was no change to see: at any width under 1366 the user got a
// highlighted rail button and a shut drawer — the #274 "no way in" complaint one step later.
// These pin the mount case, and the two neighbours it must not disturb.
//
// Issue #355 moved the breakpoint 1366 → 1024, so "compact" in these tests is now 1023, and 1024 —
// the Playwright default and every laptop — is a rail. The last block pins the width itself and the
// one-close rule that came with it.

import { describe, it, expect, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ContextPanel } from '@/components/layout/ContextPanel';
import { useViewportStore } from '@/store/viewportStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
}

// Issue #462 — jsdom has no `matchMedia`. This answers whatever `max-width` query the panel
// asks, from `innerWidth`, and records the `change` listeners so a test can fire them WITHOUT a
// `resize` event. That last part is the regression: the old implementation listened only to
// `resize`, so a mode that follows the media query — the one CSS applies — was untestable.
type MediaListener = () => void;
let mediaListeners: MediaListener[] = [];

function installMatchMedia(): void {
  mediaListeners = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        get matches() {
          const limit = /max-width:\s*(\d+)px/.exec(query);
          return limit === null ? false : window.innerWidth <= Number(limit[1]);
        },
        media: query,
        onchange: null,
        addEventListener(type: string, listener: MediaListener) {
          if (type === 'change') mediaListeners.push(listener);
        },
        removeEventListener(type: string, listener: MediaListener) {
          if (type === 'change') mediaListeners = mediaListeners.filter((l) => l !== listener);
        },
        addListener(listener: MediaListener) {
          mediaListeners.push(listener);
        },
        removeListener(listener: MediaListener) {
          mediaListeners = mediaListeners.filter((l) => l !== listener);
        },
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

function fireMediaChange(): void {
  for (const listener of [...mediaListeners]) listener();
}

function panelClass(): string {
  return screen.getByTestId('context-panel').className;
}

beforeEach(() => {
  cleanup();
  installMatchMedia();
  useViewportStore.setState({ activeSidebarSection: null, selection: null });
});

describe('#280 — the context panel mounts with a section already active', () => {
  it('opens the drawer — a compact viewport must not hide the panel it was handed', () => {
    setWidth(1023);
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    render(<ContextPanel />);
    expect(panelClass()).toContain('context-panel--drawer');
    expect(panelClass()).toContain('context-panel--open');
  });

  it('stays shut when it mounts with nothing to show', () => {
    setWidth(1023);
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

describe('#355 — the rail shares the viewport from 1024 up', () => {
  it('is a rail at 1024, the width of every laptop and every desktop e2e run', () => {
    setWidth(1024);
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    render(<ContextPanel />);
    expect(panelClass()).toContain('context-panel--rail');
    expect(screen.queryByTestId('context-panel-handle')).toBeNull();
  });

  it('still a drawer one pixel below', () => {
    setWidth(1023);
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    render(<ContextPanel />);
    expect(panelClass()).toContain('context-panel--drawer');
    expect(screen.getByTestId('context-panel-handle')).toBeTruthy();
  });

  it('takes a new mode from the media query itself, with no resize event (#462)', () => {
    setWidth(1440);
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    render(<ContextPanel />);
    expect(panelClass()).toContain('context-panel--rail');

    // The one event the CSS side acts on; the old `resize` listener would not hear it and the
    // panel would stay a rail inside a drawer layout.
    act(() => {
      setWidth(1023);
      fireMediaChange();
    });
    expect(panelClass()).toContain('context-panel--drawer');

    act(() => {
      setWidth(1440);
      fireMediaChange();
    });
    expect(panelClass()).toContain('context-panel--rail');
  });

  it('carries ONE way to close a section — the content’s own × — in either mode', () => {
    for (const w of [1024, 1440]) {
      setWidth(w);
      useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
      render(<ContextPanel />);
      // The section header's × and nothing else: no drawer × stacked under it, no handle in rail
      // mode. Found in the UI review as two close buttons reading as one control duplicated.
      const closes = screen.getAllByLabelText(/^Close/);
      expect(closes.map((el) => el.getAttribute('aria-label')), `at ${w}px`).toEqual([
        'Close section editor',
      ]);
      cleanup();
    }
  });
});

describe('#360 — the export modal leaves the drawer it is opened from', () => {
  it('mounts on the body, not inside the drawer that holds its button', () => {
    setWidth(1023);
    useViewportStore.setState({ activeSidebarSection: 'export' });
    render(<ContextPanel />);
    fireEvent.click(screen.getByTestId('export-open'));

    // The drawer is `position: fixed` WITH a `transform` and a z-index token, so as an ancestor it
    // is both the modal's containing block and its stacking context — a backdrop asking for
    // `--cm-z-modal-raised` would never leave it. Portaled, the modal answers to the window.
    const backdrop = document.querySelector('.export-modal-backdrop');
    expect(backdrop, 'the modal rendered').not.toBeNull();
    expect(backdrop!.parentElement, 'portaled to the document body').toBe(document.body);
    expect(screen.getByTestId('context-panel').contains(backdrop!), 'not inside the drawer').toBe(false);
  });
});

describe('#441 — an engrave item selected in the preview keeps its panel', () => {
  it('leaves the engrave section in the rail rather than swapping in a SelectionPanel', () => {
    setWidth(1440);
    useViewportStore.setState({
      activeSidebarSection: 'cnc-engrave',
      selection: { kind: 'engrave-item', itemId: 'label-1' },
    });
    render(<ContextPanel />);
    expect(screen.getByTestId('context-section-cnc-engrave')).toBeTruthy();
    expect(screen.queryByTestId('selection-panel')).toBeNull();
  });
});
