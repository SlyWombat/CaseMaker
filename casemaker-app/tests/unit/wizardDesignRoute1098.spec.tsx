// @vitest-environment jsdom
// #1098 item 6 — the Stock step arrives settled on a PrusaSlicer project the question step already
// recognised: it reads the file once as its own loader would, hands the wizard the pending
// `{ kind: 'design' }` with the same sha, and says what the file is — without asking for it again.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { StockStep } from '@/components/welcome/StockStep';
import type { PendingStock } from '@/components/welcome/StartStockStep';

const SHA = 'b'.repeat(64);
const stockRead = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/engine/import/meshStock', async (orig) => {
  const real = await orig<typeof import('@/engine/import/meshStock')>();
  return {
    ...real,
    readStockFile: async (file: File) => {
      stockRead.calls.push(file.name);
      return { kind: 'design', name: file.name, sha256: 'b'.repeat(64), negativeVolumes: 3 };
    },
  };
});
vi.mock('@/platform/features', async (orig) => ({ ...(await orig<typeof import('@/platform/features')>()), featureSim: true }));

afterEach(() => {
  cleanup();
  stockRead.calls = [];
});

describe('#1098 item 6 — the Stock step opens settled on the recognised project', () => {
  it('reads the preset file once and reports the design pending with the same sha', async () => {
    const onPending = vi.fn<(p: PendingStock | null) => void>();
    const file = new File(['x'], 'badge.3mf');
    render(<StockStep onPending={onPending} presetFile={file} />);
    await waitFor(() => {
      const last = onPending.mock.calls[onPending.mock.calls.length - 1]?.[0];
      expect(last).toEqual({ kind: 'design', file, sha256: SHA });
    });
    expect(stockRead.calls).toEqual(['badge.3mf']);
    expect(screen.getByText(/a PrusaSlicer project with 3 cut volumes/)).toBeTruthy();
  });

  it('without a preset the step asks for nothing it was not given', async () => {
    const onPending = vi.fn();
    render(<StockStep onPending={onPending} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(stockRead.calls).toEqual([]);
  });
});
