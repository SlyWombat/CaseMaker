// @vitest-environment jsdom
// Board origin labelling (#128).
//
// The maintainer dropped the "verified" tier — a badge reading "verified"
// claims we audited a third-party profile's dimensions, which is the one
// thing it could never mean — and asked the picker to state a board's ORIGIN
// instead: built-in versus added by you. This pins that on the cards, in the
// rail, and that the retired tier is really gone from the surface a user sees.

import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { WelcomeOverlay } from '@/components/welcome/WelcomeOverlay';
import { useLibraryStore } from '@/store/libraryStore';
import { unknownBoardKeys, localBoardProfileSchema } from '@/library/schema';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The minimum a board profile needs to validate, per the schema. */
function sampleBoard(id: string, name = 'My Test Board'): Record<string, unknown> {
  return {
    id,
    name,
    manufacturer: 'Test Bench',
    pcb: { size: { x: 40, y: 30, z: 1.6 } },
    mountingHoles: [{ id: 'h1', x: 3, y: 3, diameter: 2.5 }],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 12,
  };
}

function resetLibrary(): void {
  const s = useLibraryStore.getState();
  for (const b of [...s.localBoards]) s.removeLocalBoard(b.id);
  for (const r of [...s.remoteSources]) s.removeRemoteSource(r.id);
}

beforeEach(() => {
  resetLibrary();
  // The overlay refreshes week-old caches on mount; nothing here is stale,
  // but the call must not reach the real network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ boards: [sampleBoard('remote-bench', 'Remote Bench')] }),
    })),
  );
});

afterEach(() => {
  cleanup();
  resetLibrary();
  vi.unstubAllGlobals();
});

/** A built-in board that exists in every checkout. */
const BUILTIN = 'rpi-4b';

async function populate(): Promise<void> {
  const add = useLibraryStore.getState().addLocalBoard;
  const local = add(sampleBoard('local-bench', 'Local Bench'));
  expect(local.ok).toBe(true);
  const { source } = await useLibraryStore
    .getState()
    .addRemoteSource('https://example.com/index.json');
  expect(source).toBeDefined();
}

it('states the origin on every card, never a quality verdict (#128)', async () => {
  await populate();
  render(<WelcomeOverlay />);

  const builtin = screen.getByTestId(`welcome-origin-${BUILTIN}`);
  expect(builtin.getAttribute('data-origin')).toBe('builtin');
  expect(builtin.textContent).toBe('BUILT-IN');
  expect(builtin.getAttribute('title')).toContain('Bundled with the app');

  const local = screen.getByTestId('welcome-origin-local-bench');
  expect(local.getAttribute('data-origin')).toBe('local');
  expect(local.textContent).toBe('LOCAL');

  // The remote chip names the source, and its kind is on the element so a
  // filter or a test never has to read the label text.
  const remote = screen.getByTestId('welcome-origin-remote-bench');
  expect(remote.getAttribute('data-origin')).toBe('remote');
  expect(remote.getAttribute('title')).toContain('online source');

  // The retired tier is gone from the surface, not merely unstyled.
  expect(screen.queryByText('✓ printed')).toBeNull();
  expect(document.body.textContent).not.toMatch(/physically verified/i);
});

it('repeats the origin in words in the detail rail (#128)', async () => {
  await populate();
  render(<WelcomeOverlay />);

  fireEvent.click(screen.getByTestId(`welcome-board-${BUILTIN}`));
  const rail = screen.getByTestId('welcome-detail-origin');
  expect(rail.getAttribute('data-origin')).toBe('builtin');
  expect(rail.textContent).toContain('built in');

  fireEvent.click(screen.getByTestId('welcome-board-local-bench'));
  const localRail = screen.getByTestId('welcome-detail-origin');
  expect(localRail.getAttribute('data-origin')).toBe('local');
  expect(localRail.textContent).toContain('your library');

  // No provenance line claims a printed verification any more.
  const detail = screen.getByTestId('welcome-detail');
  expect(within(detail).queryByText(/verified/i)).toBeNull();
});

it('accepts a board still carrying the retired `verified` key, and does not warn (#128)', () => {
  const raw = { ...sampleBoard('legacy-bench'), verified: true };

  // Known-by-absence: the key is stripped, not flagged as authored-for-newer.
  expect(unknownBoardKeys(raw)).not.toContain('verified');
  const parsed = localBoardProfileSchema.safeParse(raw);
  expect(parsed.success).toBe(true);
  expect(parsed.success && 'verified' in parsed.data).toBe(false);

  // A genuinely unknown key still warns — the #129 behaviour is intact.
  expect(unknownBoardKeys({ ...raw, nonsense: 1 })).toEqual(['nonsense']);

  const result = useLibraryStore.getState().addLocalBoard(raw);
  expect(result.ok).toBe(true);
  expect(result.warnings.join(' ')).not.toMatch(/verified/);
});
