// @vitest-environment jsdom
/**
 * #878 — the welcome page's front door: the four capability cards and where each one leads.
 *
 * Cases leads to the board catalog (the search takes focus), Racks and Toolboxes build their
 * project straight away and leave welcome mode, and CNC opens the cutting wizard. The pictures are
 * inline SVG with a name for assistive tech, and the copy carries no issue number.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WelcomeOverlay } from '@/components/welcome/WelcomeOverlay';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import { derivedKind } from '@/engine/compiler/archetype';

// A template's mesh build is the geometry scheduler's; this test is about the door.
vi.mock('@/engine/jobs/JobScheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/jobs/JobScheduler')>();
  return { ...actual, scheduleImmediate: vi.fn(async () => {}) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOORS = ['welcome-door-print', 'welcome-door-racks', 'welcome-door-toolboxes', 'welcome-door-cnc'] as const;

beforeEach(() => {
  cleanup();
  resetStartWizard();
  useProjectStore.getState().showWelcome();
  useViewportStore.getState().setActiveSidebarSection(null);
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
});

describe('the four capability cards', () => {
  it('are all present, each with a named picture, a headline, one line and one action', () => {
    render(<WelcomeOverlay />);
    for (const id of DOORS) {
      const card = screen.getByTestId(id);
      const art = card.querySelector('svg[role="img"]');
      expect(art, `${id} has an illustration`).not.toBeNull();
      expect(art?.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(10);
      expect(within(card).getByRole('heading', { level: 2 }).textContent?.trim().split(/\s+/).length).toBeLessThanOrEqual(5);
      // #1123 item 1 — the whole tile is the control: the card itself is the button, and the
      // action label is inside it (a span — a button may not nest inside a button).
      expect(card.getAttribute('role')).toBe('button');
      expect(card.getAttribute('tabindex')).toBe('0');
      expect(card.querySelector('button')).toBeNull();
    }
    const doors = screen.getByTestId('welcome-doors');
    // Operator copy names no issue and no internal file.
    expect(doors.textContent).not.toMatch(/#\d+/);
    expect(doors.textContent).not.toMatch(/\.md\b/);
    expect(doors.textContent).not.toMatch(/\bPLA\b/);
  });

  it('Cases hands the cursor to the board search', () => {
    render(<WelcomeOverlay />);
    fireEvent.click(screen.getByTestId('welcome-start-case'));
    expect(document.activeElement).toBe(screen.getByTestId('welcome-search'));
    expect(useProjectStore.getState().welcomeMode).toBe(true);
  });

  it('Racks builds the mini rack and lands in the rack editor', async () => {
    render(<WelcomeOverlay />);
    fireEvent.click(screen.getByTestId('welcome-start-rack'));
    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(derivedKind(useProjectStore.getState().project)).toBe('rack');
    await waitFor(() => expect(useViewportStore.getState().activeSidebarSection).toBe('rack'));
  });

  it('Toolboxes builds the stacking toolbox and lands in the toolbox editor', async () => {
    render(<WelcomeOverlay />);
    fireEvent.click(screen.getByTestId('welcome-start-toolbox'));
    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(derivedKind(useProjectStore.getState().project)).toBe('toolbox');
    await waitFor(() => expect(useViewportStore.getState().activeSidebarSection).toBe('toolbox'));
  });

  it('CNC opens the cutting wizard over the page', () => {
    render(<WelcomeOverlay />);
    fireEvent.click(screen.getByTestId('welcome-start-cnc'));
    expect(useStartWizardStore.getState().open).toBe(true);
    expect(useProjectStore.getState().welcomeMode).toBe(true);
  });

  // #1123 item 1 — THE WHOLE TILE IS THE CONTROL. The maintainer pressed the picture and the
  // title and nothing happened; only the small button at the foot acted. The picture must be the
  // same way in as the button, for every tile.
  it('#1123 — a click on the picture fires the same action as the button', () => {
    render(<WelcomeOverlay />);
    const picture = screen.getByTestId('welcome-door-cnc').querySelector('svg[role="img"]');
    expect(picture).not.toBeNull();
    fireEvent.click(picture!);
    expect(useStartWizardStore.getState().open).toBe(true);
    expect(useProjectStore.getState().welcomeMode).toBe(true);
  });

  it('#1123 — the Cases tile’s picture hands the cursor to the board search, like its label', () => {
    render(<WelcomeOverlay />);
    const picture = screen.getByTestId('welcome-door-print').querySelector('svg[role="img"]');
    fireEvent.click(picture!);
    expect(document.activeElement).toBe(screen.getByTestId('welcome-search'));
    expect(useProjectStore.getState().welcomeMode).toBe(true);
  });
});
