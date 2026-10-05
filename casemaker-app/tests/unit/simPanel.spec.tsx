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
    // #197 — the store fetches the whole path after a successful or path-only load.
    simPath: async () => ({ xyz: new Float32Array(0), step: new Uint32Array(0), kind: new Uint8Array(0), t: new Float32Array(0) }),
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

/** A swept load that carries a fixture obstacle and a diagnostic that names a line (#243, #245). */
const READY_COVERED = {
  ok: true,
  diagnostics: [
    { source: 'sweep', severity: 'error', code: 'rapid-into-fixture', message: 'line 3: a rapid drives the tool into the fixture', line: 3, checkpoint: 2 },
  ],
  summary: { diagnosticCounts: {} },
  stats: { removedVolume: 12.5, ms: { total: 100 } },
  count: 4,
  meshes: { stock: {}, result: {}, removal: null, gouges: [], fixture: [{ id: 'jaw1', label: 'vise-jaw-front', mesh: {} }] },
  fixtureSource: 'default',
  fixtureUncertainty: 0.5,
} as unknown as SimLoadResult;

/** The runner produced a path and the sweep refused: a path-only session (#194). */
const REFUSED_PATH_ONLY = {
  ok: false,
  pathOnly: true,
  diagnostics: [{ source: 'sweep', severity: 'error', code: 'sweep-budget-exceeded', message: 'too slow', line: 7 }],
  summary: { steps: 3, diagnosticCounts: {} },
  pauses: [],
  segments: [],
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

  it('names the geometry this run did not check (#243)', async () => {
    setSimClientLoader(async () => fakeClient(READY_COVERED));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');
    const text = screen.getByTestId('sim-disclaimer').textContent ?? '';
    expect(text).toContain('the modelled fixture (vise-jaw-front)');
    expect(text).toContain('a shipped default, not a measurement');
    expect(text).toContain('the collet nut');
    expect(text).toContain('the spindle body, head and gantry');
  });

  it('says a path-only run checked nothing but the path', async () => {
    setSimClientLoader(async () => fakeClient(REFUSED_PATH_ONLY));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-refusal');
    expect(screen.getByTestId('sim-disclaimer').textContent).toContain('path-only');
  });

  it('jumps to a diagnostic’s line in the G-code pane when its line is clicked (#245)', async () => {
    setSimClientLoader(async () => fakeClient(READY_COVERED));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');
    expect(screen.queryByTestId('sim-gcode-jump')).toBeNull();

    fireEvent.click(screen.getByTestId('sim-diag-jump-sweep-rapid-into-fixture'));
    expect(screen.getByTestId('sim-gcode-jump').getAttribute('data-line')).toBe('3');
  });
});
