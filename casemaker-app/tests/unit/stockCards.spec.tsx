// @vitest-environment jsdom
// #1105 — THE STOCK STEP'S BLANK CARDS, on the existing shelf data (the location `blanks[]` rows are
// land18). The step-2 proposal is a card; every shelf row is shown across materials, the ones that
// do not match the selected material greyed; the vocabulary is ordered Woods first; mm/in types in
// inches and stores millimetres.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import locationDoc from './fixtures/location-doc.json';
import { StartStockStep, type PendingStock, type StartStockSeed } from '@/components/welcome/StartStockStep';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import { resetStockStore } from '@/store/stockStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHELF = (locationDoc as { stock: unknown[] }).stock;
const HARDWOOD = {
  ...(SHELF[0] as Record<string, unknown>),
  id: 'stock-hardwood',
  material: 'hardwood',
  form: 'block',
  size: { length: 120, width: 75, thickness: 50 },
  quantity: 1,
  reservations: [],
};

/** The service's shelf: GET only; the step's refresh reads it. */
function fakeShelf(items: unknown[]): void {
  const client = {
    call: async (method: string, path: string): Promise<HouseCall> => {
      if (method === 'GET' && path === '/stock') return { kind: 'ok', text: JSON.stringify(items), etag: '"s-1"' };
      return { kind: 'refused', status: 400, message: `unexpected ${method} ${path}` };
    },
  } as unknown as HouseClient;
  setHouseClientLoader(async () => client);
}

const SEED: StartStockSeed = {
  form: 'plate',
  material: 'hardwood',
  length: 75,
  width: 72.7,
  thickness: 20.1,
  finish: 'rough',
  computed: true,
  sentence: 'Sized from the mesh: 75 × 72.7 × 20.1 mm',
};

beforeEach(() => {
  cleanup();
  resetMachineStore();
  useSettingsStore.getState().resetSettings();
  resetStockStore();
  useEngraveJobStore.setState({ job: defaultEngraveJob() });
});

afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
});

describe('#1105 the Stock step blank cards', () => {
  it('shows the step-2 proposal first, every shelf row next, and greys the other materials', async () => {
    fakeShelf([HARDWOOD, SHELF[0], SHELF[1]]);
    render(<StartStockStep onChange={vi.fn()} seed={SEED} />);

    const design = await screen.findByTestId('start-wizard-blank-card-design');
    expect(design.textContent).toContain('From your design');
    expect(design.textContent).toContain('75 × 72.7 × 20.1 mm');
    // The shelf rows are all present; the two in other materials are disabled and say why.
    const other = await screen.findByTestId('start-wizard-shelf-item-stock-plate1');
    expect((other as HTMLButtonElement).disabled).toBe(true);
    expect(other.getAttribute('data-state')).toBe('other');
    expect(screen.getByTestId('start-wizard-shelf-item-stock-hardwood').getAttribute('data-state')).toBe('ok');
    expect(screen.getByTestId('start-wizard-shelf-other').textContent).toContain('other materials');
  });

  it('picking the matching shelf card fills the form and hands the wizard a shelf entry', async () => {
    fakeShelf([HARDWOOD]);
    let last: PendingStock | null = null;
    render(<StartStockStep onChange={(p) => (last = p)} seed={SEED} />);
    const card = await screen.findByTestId('start-wizard-shelf-item-stock-hardwood');
    fireEvent.click(card);
    await waitFor(() => {
      expect(last?.kind).toBe('choice');
    });
    if (last?.kind === 'choice') expect(last.choice.entry.kind).toBe('shelf');
    expect((screen.getByTestId('start-wizard-make-length') as HTMLInputElement).value).toBe('120');
  });

  it('lists the vocabulary Woods first, with the boards and foams family offered', async () => {
    fakeShelf([]);
    render(<StartStockStep onChange={vi.fn()} />);
    const select = screen.getByTestId('start-wizard-stock-material');
    const groups = [...select.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'));
    expect(groups[0]).toBe('Woods');
    expect(groups).toContain('Boards & foams');
    const epoxy = [...select.querySelectorAll('option')].find((o) => (o as HTMLOptionElement).value === 'epoxy-tooling');
    expect(epoxy).toBeTruthy();
  });

  it('types inches and stores millimetres, stating both', async () => {
    fakeShelf([]);
    render(<StartStockStep onChange={vi.fn()} seed={SEED} />);
    fireEvent.click(screen.getByTestId('start-wizard-size-in'));
    const length = screen.getByTestId('start-wizard-make-length') as HTMLInputElement;
    fireEvent.change(length, { target: { value: '0.15' } });
    expect(screen.getByTestId('start-wizard-stock-size-both').textContent).toBe('0.15 in = 3.81 mm');
    // Back to mm: the same number is shown in the job's own unit.
    fireEvent.click(screen.getByTestId('start-wizard-size-mm'));
    expect((screen.getByTestId('start-wizard-make-length') as HTMLInputElement).value).toBe('3.81');
  });

  it('the finish hint is the selected material family’s', async () => {
    fakeShelf([]);
    render(<StartStockStep onChange={vi.fn()} seed={SEED} />);
    expect(screen.getByTestId('start-wizard-stock-finish-hint').textContent).toContain('faced first unless you say it is planed');
    fireEvent.change(screen.getByTestId('start-wizard-stock-material'), { target: { value: 'pla' } });
    expect(screen.getByTestId('start-wizard-stock-finish-hint').textContent).toContain('is cut as it is; no facing');
  });
});
