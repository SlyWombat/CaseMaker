// @vitest-environment jsdom
// The Simulate panel (#196 §5): the Simulate gate, the true runner count, the refusal banner and
// the disclaimer. A fake client stands in for the worker (`setSimClientLoader`).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SimPanel } from '@/components/panels/SimPanel';
import { setSimClientLoader, useSimStore, type SimClient } from '@/store/simStore';
import { useSimSetupStore } from '@/store/simSetupStore';
import type { SimDiagnostic, SimLoadResult } from '@/workers/sim/session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHOSEN_TOOL = 'flat-3.175x12-metal';

/** A worker client that returns one canned load result and ignores the sinks. */
function fakeClient(result: SimLoadResult): SimClient {
  return {
    setSimSinks: () => {},
    loadSim: async () => result,
    requestFrame: () => {},
    disposeSim: async () => {},
  } as unknown as SimClient;
}

/** 25 listed records for a code whose true count the runner summary says is 30. */
const CAPPED: SimDiagnostic[] = Array.from({ length: 25 }, () => ({
  source: 'runner',
  severity: 'error',
  code: 'outside-envelope',
  message: 'a move leaves the envelope',
}));

const READY = {
  ok: true,
  diagnostics: CAPPED,
  summary: { diagnosticCounts: { 'outside-envelope': 30 } },
  stats: { removedVolume: 1284.6, ms: { total: 840 } },
  count: 10,
  meshes: { stock: {}, result: {}, removal: null, gouges: [] },
} as unknown as SimLoadResult;

const REFUSED = {
  ok: false,
  pathOnly: false,
  diagnostics: [
    { source: 'sweep', severity: 'error', code: 'too-many-checkpoints', message: '482 Z levels — a 3D job V1 does not simulate.' },
  ],
} as unknown as SimLoadResult;

function openPlainFile(): void {
  // No header: stock defaults, and the tool starts unset.
  useSimSetupStore.getState().openFile('plain.nc', 'G0 X0 Y0\nG1 Z-1 F100\n');
}

beforeEach(() => {
  useSimSetupStore.getState().reset();
  setSimClientLoader(async () => fakeClient(REFUSED));
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await useSimStore.getState().dispose();
  });
  setSimClientLoader(null);
});

describe('SimPanel', () => {
  it('disables Simulate until a tool is selected', async () => {
    openPlainFile();
    render(<SimPanel />);
    const button = screen.getByTestId('sim-simulate') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    expect((screen.getByTestId('sim-simulate') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the runner summary count, not the capped list length', async () => {
    setSimClientLoader(async () => fakeClient(READY));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    const row = await screen.findByTestId('sim-diag-runner-outside-envelope');
    expect(row.textContent).toContain('30');
    expect(row.textContent).not.toContain('25');
  });

  it('renders a refusal banner and no result block', async () => {
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-refusal');
    expect(screen.getByText(/482 Z levels/)).toBeTruthy();
    expect(screen.queryByTestId('sim-result')).toBeNull();
  });

  it('shows the disclaimer after a successful load', async () => {
    setSimClientLoader(async () => fakeClient(READY));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');
    expect(screen.getByTestId('sim-disclaimer').textContent).toContain('rigid, ideal machine');
  });
});
