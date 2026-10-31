// @vitest-environment jsdom
/**
 * #743 P-4b review — the panel's Gerber door does not REFUSE a board on a non-PCB blank.
 *
 * A practice cut in PLA is legitimate: the import proceeds, states the fact in one sentence beside
 * the Add menu, and offers "Use PCB stock" — one click restates the material and gives it copper's
 * cap. The door's own file reading and geometry are pinned elsewhere (`pcbJobImport.spec.ts`,
 * `pcbImport.spec.ts`); the two loaded modules are stubbed so this test pins the DOOR's wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/workers/geometry/ManifoldRuntime', () => ({ getToplevel: async () => ({}) }));
vi.mock('@/engine/import/pcbJobImport', () => ({
  planPcbJobImport: async () => ({
    ok: true as const,
    plan: {
      files: [{ name: 'practice-F_Cu.gbr', kind: 'gerber' }],
      board: { left: 0, top: 0, width: 1, height: 1 },
      mount: { kind: 'tape' },
      mirrored: false,
      twoSided: false,
      second: null,
      copperId: 'vec-copper',
      outlineId: 'vec-outline',
      items: { vectors: [], frames: [], drills: [], cutouts: [] },
      notes: [],
      warnings: [],
    },
    sources: [],
    skipped: [],
  }),
}));

import { EngravePanel } from '@/components/panels/EngravePanel';
import { PCB_COPPER_MM } from '@/engine/cnc/stockStart';
import { useEngraveJobStore } from '@/store/engraveJobStore';

function pickFiles(testId: string, files: File[]): void {
  const input = screen.getByTestId(testId) as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('the panel Gerber door (#743 P-4b review)', () => {
  beforeEach(() => {
    useEngraveJobStore.getState().reset();
    useEngraveJobStore.getState().setStock({ material: 'pla', colour: undefined });
  });
  afterEach(cleanup);

  it('imports onto the PLA blank anyway, states the fact, and fixes it in one click', async () => {
    render(<EngravePanel />);

    pickFiles('engrave-pcb-input', [new File([new Uint8Array([1, 2, 3])], 'practice-F_Cu.gbr')]);

    const notice = await screen.findByTestId('engrave-pcb-stock-notice');
    expect(notice.textContent).toContain(
      "This job's stock is PLA; a circuit board is cut from copper-clad PCB.",
    );
    // The import happened: the message reports the board, and the stock is still the operator's.
    expect(screen.getByTestId('engrave-pcb-message').textContent).toMatch(/Imported 1 file/);
    expect(useEngraveJobStore.getState().job.stock.material).toBe('pla');
    // The board is a whole job: the shipped demo lines (CASE / MAKER / first chips) are gone.
    expect(useEngraveJobStore.getState().job.labels).toEqual([]);

    fireEvent.click(screen.getByTestId('engrave-pcb-use-stock'));
    await waitFor(() =>
      expect(screen.queryByTestId('engrave-pcb-stock-notice')).toBeNull(),
    );
    const stock = useEngraveJobStore.getState().job.stock;
    expect(stock.material).toBe('pcb');
    expect(stock.colour).toEqual({ kind: 'laminate', capMm: PCB_COPPER_MM });
  });

  it('puts the board on the bed, taped, when it lands on a fresh document (#743 P-6)', async () => {
    render(<EngravePanel />);
    pickFiles('engrave-pcb-input', [new File([new Uint8Array([1, 2, 3])], 'practice-F_Cu.gbr')]);
    await screen.findByTestId('engrave-pcb-message');

    // A board is taped flat to the bed over a board under it (design D8): the through cuts and the
    // 0.1 mm isolation both need it, and the import must not leave the fresh job in the vise.
    const job = useEngraveJobStore.getState().job;
    expect(job.workholding.kind).toBe('tape');
    expect(job.sacrificial.under?.attach).toBe('tape');
    expect(screen.queryByTestId('engrave-pcb-holding-notice')).toBeNull();
  });

  it('keeps an operator’s holding, states the board’s, and tapes it in one click (#743 P-6)', async () => {
    // A job the operator has worked on is not a fresh document: its holding is theirs.
    const first = useEngraveJobStore.getState().job.labels[0]!;
    useEngraveJobStore.getState().updateLabel(first.id, { text: 'HELLO' });
    render(<EngravePanel />);
    pickFiles('engrave-pcb-input', [new File([new Uint8Array([1, 2, 3])], 'practice-F_Cu.gbr')]);

    const notice = await screen.findByTestId('engrave-pcb-holding-notice');
    expect(notice.textContent).toContain('taped flat to the bed, over a board under it');
    expect(useEngraveJobStore.getState().job.workholding.kind).toBe('vise');

    fireEvent.click(screen.getByTestId('engrave-pcb-use-holding'));
    await waitFor(() => expect(screen.queryByTestId('engrave-pcb-holding-notice')).toBeNull());
    const job = useEngraveJobStore.getState().job;
    expect(job.workholding.kind).toBe('tape');
    expect(job.sacrificial.under).not.toBeNull();
  });
});
