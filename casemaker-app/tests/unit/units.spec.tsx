// @vitest-environment jsdom
// #1105 item 1 — INCHES ARE A TYPING UNIT. The job stays in mm; an inch entry is parsed on blur,
// stored as millimetres (3 dp), and the typed text is never rewritten under the operator's cursor
// while they type it. The sentence states both numbers once the entry is committed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { StartStockStep, type PendingStock, type StartStockSeed } from '@/components/welcome/StartStockStep';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import { resetStockStore } from '@/store/stockStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The service's shelf: GET only; an empty shelf is all this spec needs. */
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
  fakeShelf([]);
});

afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
});

describe('#1105 inches are a typing unit', () => {
  it('typing 0.15 with in selected stores 3.81 mm and the sentence shows both', async () => {
    let last: PendingStock | null = null;
    render(<StartStockStep onChange={(p) => (last = p)} seed={SEED} />);
    fireEvent.click(screen.getByTestId('start-wizard-size-in'));

    const length = screen.getByTestId('start-wizard-make-length');
    fireEvent.change(length, { target: { value: '0.15' } });
    fireEvent.blur(length);

    await waitFor(() => {
      expect(screen.getByTestId('start-wizard-stock-size-both').textContent).toContain('0.15 in = 3.81 mm');
    });
    // The stored value is millimetres: switching back shows it.
    fireEvent.click(screen.getByTestId('start-wizard-size-mm'));
    expect((screen.getByTestId('start-wizard-make-length') as HTMLInputElement).value).toBe('3.81');
    // …and the wizard's pending answer carries the same millimetres (the cast lifts TS's closure
    // narrowing: a variable only ever written in the callback reads as `null` here otherwise).
    const done = last as PendingStock | null;
    expect(done?.kind).toBe('choice');
    if (done?.kind === 'choice') expect(done.choice.stock.length).toBeCloseTo(3.81, 3);
  });

  it('1.2345 is not rewritten while typing', () => {
    render(<StartStockStep onChange={vi.fn()} seed={SEED} />);
    fireEvent.click(screen.getByTestId('start-wizard-size-in'));

    const length = screen.getByTestId('start-wizard-make-length');
    // One character at a time, as a person types it: the field must show exactly what was typed.
    for (const text of ['1', '1.2', '1.23', '1.234', '1.2345']) {
      fireEvent.change(length, { target: { value: text } });
      expect((screen.getByTestId('start-wizard-make-length') as HTMLInputElement).value).toBe(text);
    }
    // The commit is on blur, and it is the parsed millimetres that land.
    fireEvent.blur(length);
    expect(screen.getByTestId('start-wizard-stock-size-both').textContent).toContain('1.2345 in = 31.356 mm');
  });
});
