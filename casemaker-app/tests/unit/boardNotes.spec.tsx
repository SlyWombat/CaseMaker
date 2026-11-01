// @vitest-environment jsdom
// Board notes in the picker (#622): a profile's own assumptions show in the
// detail pane, under the provenance, labelled "Notes".

import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { WelcomeOverlay } from '@/components/welcome/WelcomeOverlay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  // The overlay refreshes stale caches on mount; keep it off the network.
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

it('shows the Q8B notes under the provenance', () => {
  render(<WelcomeOverlay />);
  fireEvent.click(screen.getByTestId('welcome-board-radxa-dragon-q8b'));

  const notes = screen.getByTestId('welcome-board-notes');
  expect(notes.textContent).toMatch(/heatsink/i);
  expect(notes.textContent).toContain('NOTES.md');

  // Labelled "Notes", and placed after the Provenance heading.
  const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
  expect(headings).toContain('Notes');
  expect(headings.indexOf('Notes')).toBeGreaterThan(headings.indexOf('Provenance'));
  expect(headings.indexOf('Provenance')).toBeGreaterThanOrEqual(0);
});

it('shows no Notes section for a board without notes', () => {
  render(<WelcomeOverlay />);
  fireEvent.click(screen.getByTestId('welcome-board-rpi-4b'));
  expect(screen.queryByTestId('welcome-board-notes')).toBeNull();
});
