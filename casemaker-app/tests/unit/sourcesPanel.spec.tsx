// @vitest-environment jsdom
// The Sources panel's per-board validation detail (#132): a rejected index
// entry should be inspectable, not just counted. The store does the parsing;
// this exercises what the operator actually sees.

import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SourcesPanel } from '@/components/welcome/SourcesPanel';
import { useLibraryStore } from '@/store/libraryStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sampleBoard(id: string): Record<string, unknown> {
  return {
    id,
    name: 'My Test Board',
    manufacturer: 'Test Bench',
    pcb: { size: { x: 40, y: 30, z: 1.6 } },
    mountingHoles: [{ id: 'h1', x: 3, y: 3, diameter: 2.5 }],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 12,
  };
}

function okJson(payload: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
  };
}

function resetLibrary(): void {
  const s = useLibraryStore.getState();
  for (const b of [...s.localBoards]) s.removeLocalBoard(b.id);
  for (const r of [...s.remoteSources]) s.removeRemoteSource(r.id);
}

beforeEach(resetLibrary);
afterEach(() => {
  cleanup();
  resetLibrary();
  vi.unstubAllGlobals();
});

it('names the entries a source rejected in the invalid badge title (#132)', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ boards: [sampleBoard('good'), { id: 'broken' }] }),
    })),
  );
  const { source } = await useLibraryStore
    .getState()
    .addRemoteSource('https://example.com/i.json');

  render(<SourcesPanel />);

  const badge = screen.getByTestId(`welcome-source-invalid-${source!.id}`);
  expect(badge.textContent).toContain('1 invalid skipped');
  const title = badge.getAttribute('title') ?? '';
  expect(title).toContain('#2 (broken)');
  expect(title.length).toBeGreaterThan('#2 (broken): '.length); // carries a reason, not just a name
});

it('offers a refresh when a check finds a board changed upstream (#128)', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => okJson({ boards: [{ ...sampleBoard('community-board'), version: 1 }] })),
  );
  const { source } = await useLibraryStore
    .getState()
    .addRemoteSource('https://example.com/i.json');

  render(<SourcesPanel />);

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => okJson({ boards: [{ ...sampleBoard('community-board'), version: 2 }] })),
  );
  fireEvent.click(screen.getByTestId(`welcome-source-check-${source!.id}`));

  const badge = await screen.findByTestId(`welcome-source-updates-${source!.id}`);
  expect(badge.textContent).toContain('1 changed upstream');
  const title = badge.getAttribute('title') ?? '';
  expect(title).toContain('community-board');
  expect(title).toContain('1 → 2');
});

it('reports a source up to date when the versions match (#128)', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => okJson({ boards: [{ ...sampleBoard('community-board'), version: 5 }] })),
  );
  const { source } = await useLibraryStore
    .getState()
    .addRemoteSource('https://example.com/i.json');

  render(<SourcesPanel />);

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => okJson({ boards: [{ ...sampleBoard('community-board'), version: 5 }] })),
  );
  fireEvent.click(screen.getByTestId(`welcome-source-check-${source!.id}`));

  const badge = await screen.findByTestId(`welcome-source-updates-${source!.id}`);
  expect(badge.textContent).toContain('up to date');
});
