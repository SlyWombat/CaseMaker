// @vitest-environment jsdom
// Issue #134 — below 640px the header toolbar collapsed its secondary controls
// (New / Save as / Load / Export / Parts / Docs / settings) behind a silent
// horizontal swipe: 848px of content in a 390px scroll container. They must be
// reachable from a ⋯ overflow menu instead, while the desktop bar is unchanged.

import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Toolbar } from '@/components/layout/Toolbar';
import { useProjectStore } from '@/store/projectStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
}

beforeEach(() => {
  cleanup();
  setWidth(1280);
  useProjectStore.setState({ welcomeMode: false });
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
