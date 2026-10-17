// @vitest-environment jsdom
// #466 — the vendor size PICKER on the add form: rows grouped by the vendor's own material word,
// a pick filling only the dimensions the row states, and the three ways the read can disappoint
// (404, error, an unreadable row) leaving the #413 form exactly as it was.
//
// The rows here are SYNTHETIC, as `materialSpecs.spec.ts`'s are: no vendor row, word or number is
// committed to the repo (#347 Route A). The material word on a row is a LABEL, never a mapping.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MaterialsScope } from '@/components/manage/MaterialsScope';
import { specSizeFields } from '@/components/manage/vendorSizes';
import { setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import { MaterialSpecSchema } from '@/platform/materialSpecsClient';
import { resetStockStore } from '@/store/stockStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELF = (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { stock: unknown[] })
  .stock;

/** A rectangular blank, as `catalogue.rs` serves one. */
const RECT = {
  id: 'spec-r-1',
  material: 'Hardwood',
  name: 'Hardwood / 200mm * 100mm * 5mm',
  shape: 'R',
  length: 200,
  width: 100,
  height: 5,
  diameter: null,
  stockCode: '9990000000000001',
};

/** A round bar, same row shape with the other dims. */
const ROUND = {
  id: 'spec-c-1',
  material: 'Hardwood',
  name: 'Hardwood Dowel / 12mm * 300mm',
  shape: 'C',
  length: 300,
  width: null,
  height: null,
  diameter: 12,
  stockCode: '',
};

/** A second material word, so grouping is observable. */
const OTHER = { ...RECT, id: 'spec-r-2', material: 'Acrylic', name: 'Acrylic / 80mm * 120mm * 3mm', width: 80, height: 3 };

/**
 * The house service: the shelf from the shared fixture, and whatever the vendor-size read should
 * answer — a list of rows, `absent` (the 404 of a service from before #446) or `error`.
 */
function fakeService(sizes: unknown[] | 'absent' | 'error') {
  const calls: string[] = [];
  const client = {
    call: async (method: string, path: string): Promise<HouseCall> => {
      calls.push(`${method} ${path}`);
      if (method === 'GET' && path === '/material-specs') {
        if (sizes === 'absent') return { kind: 'refused', status: 404, message: 'no sizes on this service' };
        if (sizes === 'error') return { kind: 'refused', status: 500, message: 'the catalogue is damaged' };
        return { kind: 'ok', text: JSON.stringify(sizes), etag: '"specs-1"' };
      }
      if (method === 'GET' && path === '/stock') return { kind: 'ok', text: JSON.stringify(SHELF), etag: '"s-1"' };
      return { kind: 'ok', text: '' };
    },
  } as unknown as HouseClient;
  setHouseClientLoader(async () => client);
  return { calls };
}

/** Render the scope and open the add form, where the picker lives. */
async function openAddForm() {
  render(<MaterialsScope />);
  await screen.findByTestId('manage-stock-table');
  fireEvent.click(screen.getByTestId('manage-stock-add'));
  await screen.findByTestId('manage-stock-form');
}

function valueOf(testid: string): string {
  return (screen.getByTestId(testid) as HTMLInputElement | HTMLSelectElement).value;
}

beforeEach(() => {
  resetStockStore();
  useToolRegistryStore.setState({ status: 'present' });
});
afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
  useToolRegistryStore.setState({ status: 'checking' });
});

describe('the shape → size fields conversion (#466)', () => {
  it('fills a rectangular row’s three dimensions, and only those', () => {
    expect(specSizeFields(MaterialSpecSchema.parse(RECT))).toEqual({ length: 200, width: 100, thickness: 5 });
  });

  it('fills a round row’s diameter and length, and only those', () => {
    expect(specSizeFields(MaterialSpecSchema.parse(ROUND))).toEqual({ length: 300, diameter: 12 });
  });
});

describe('#466 the vendor size picker', () => {
  it('lists the served rows grouped by their own material word, labelled with their own name', async () => {
    fakeService([RECT, ROUND, OTHER]);
    await openAddForm();
    const picker = (await screen.findByTestId('manage-stock-vendor-size')) as HTMLSelectElement;

    expect(Array.from(picker.querySelectorAll('optgroup')).map((g) => g.getAttribute('label'))).toEqual([
      'Hardwood',
      'Acrylic',
    ]);
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual([
      'type the size yourself…',
      RECT.name,
      ROUND.name,
      OTHER.name,
    ]);
  });

  it('a pick fills only the dimensions the row states; material, form, finish and quantity stay the user’s', async () => {
    fakeService([RECT, ROUND]);
    await openAddForm();
    const picker = await screen.findByTestId('manage-stock-vendor-size');
    const before = {
      material: valueOf('manage-stock-material'),
      form: valueOf('manage-stock-form'),
      finish: valueOf('manage-stock-finish'),
      quantity: valueOf('manage-stock-quantity'),
    };

    // A round row on the default plate form: length is filled, and the panel says why the diameter
    // is not shown — the form is the user's choice, not the picker's.
    fireEvent.change(picker, { target: { value: ROUND.id } });
    expect(valueOf('manage-stock-size-length')).toBe('300');
    expect(screen.queryByTestId('manage-stock-size-diameter')).toBeNull();
    expect(screen.getByTestId('manage-stock-vendor-form-hint').textContent).toContain('round size');
    expect(valueOf('manage-stock-material')).toBe(before.material);
    expect(valueOf('manage-stock-form')).toBe(before.form);
    expect(valueOf('manage-stock-finish')).toBe(before.finish);
    expect(valueOf('manage-stock-quantity')).toBe(before.quantity);

    // Choosing the form the row's shape fits brings the diameter out of the draft — still no retyping.
    fireEvent.change(screen.getByTestId('manage-stock-form'), { target: { value: 'rod' } });
    expect(valueOf('manage-stock-size-diameter')).toBe('12');
    expect(valueOf('manage-stock-size-length')).toBe('300');
    expect(screen.queryByTestId('manage-stock-vendor-form-hint')).toBeNull();
    expect(valueOf('manage-stock-material')).toBe(before.material);
    expect((screen.getByTestId('manage-stock-save') as HTMLButtonElement).disabled).toBe(false);

    // A rectangular row does the same in reverse, and still touches nothing but the size.
    fireEvent.change(picker, { target: { value: RECT.id } });
    expect(valueOf('manage-stock-size-length')).toBe('200');
    fireEvent.change(screen.getByTestId('manage-stock-form'), { target: { value: 'plate' } });
    expect(valueOf('manage-stock-size-width')).toBe('100');
    expect(valueOf('manage-stock-size-thickness')).toBe('5');
    expect(valueOf('manage-stock-material')).toBe(before.material);
    expect(valueOf('manage-stock-finish')).toBe(before.finish);
    expect(valueOf('manage-stock-quantity')).toBe(before.quantity);
  });

  it('a 404 (a service from before #446) hides the picker without an error, and the form works as before', async () => {
    const svc = fakeService('absent');
    await openAddForm();
    await waitFor(() => expect(svc.calls).toContain('GET /material-specs'));
    expect(screen.queryByTestId('manage-stock-vendor-size')).toBeNull();
    expect(screen.queryByTestId('manage-stock-vendor-error')).toBeNull();
    expect(screen.queryByTestId('manage-stock-vendor-unreadable')).toBeNull();
    // The #413 form is intact: typing a size is still the whole story.
    expect(screen.getByTestId('manage-stock-size-length')).toBeTruthy();
    expect(screen.getByTestId('manage-stock-size-width')).toBeTruthy();
  });

  it('sets an unreadable row aside with its reason, and still offers the rest', async () => {
    fakeService([RECT, { ...RECT, id: 'spec-bad', width: null }]);
    await openAddForm();
    const picker = (await screen.findByTestId('manage-stock-vendor-size')) as HTMLSelectElement;

    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['', RECT.id]);
    const hint = screen.getByTestId('manage-stock-vendor-unreadable');
    expect(hint.textContent).toContain('spec-bad');
    expect(hint.textContent).toContain('width');
  });

  it('an error on the read is a hint beside a working form, not a broken picker', async () => {
    const svc = fakeService('error');
    await openAddForm();
    await waitFor(() => expect(svc.calls).toContain('GET /material-specs'));
    expect(screen.getByTestId('manage-stock-vendor-error').textContent).toContain('the catalogue is damaged');
    expect(screen.queryByTestId('manage-stock-vendor-size')).toBeNull();
    expect(screen.getByTestId('manage-stock-size-length')).toBeTruthy();
  });
});
