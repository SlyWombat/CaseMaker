// @vitest-environment jsdom
// #413 — Manage › Materials: the shelf listed, an entry added through the form, edited and removed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MaterialsScope } from '@/components/manage/MaterialsScope';
import { setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import { resetStockStore, useStockStore } from '@/store/stockStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELF = (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { stock: unknown[] })
  .stock;

function fakeShelf() {
  let items = JSON.parse(JSON.stringify(SHELF)) as Array<{ id: string }>;
  let version = 1;
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const client = {
    call: async (method: string, path: string, body?: unknown, opts?: { ifMatch?: string | null }): Promise<HouseCall> => {
      // A service from before #446: no vendor sizes to offer, and the add form is the #413 one.
      if (method === 'GET' && path === '/material-specs') {
        return { kind: 'refused', status: 404, message: 'no sizes on this service' };
      }
      if (method === 'GET') return { kind: 'ok', text: JSON.stringify(items), etag: `"${version}"` };
      sent.push({ method, path, body });
      if (method !== 'POST' && opts?.ifMatch !== `"${version}"`) return { kind: 'refused', status: 412, message: 'stale' };
      const id = decodeURIComponent(path.replace('/stock/', ''));
      if (method === 'POST') items.push(body as { id: string });
      if (method === 'PATCH') items = items.map((i) => (i.id === id ? (body as { id: string }) : i));
      if (method === 'DELETE') items = items.filter((i) => i.id !== id);
      version += 1;
      return { kind: 'ok', text: '' };
    },
  } as unknown as HouseClient;
  setHouseClientLoader(async () => client);
  return { sent, items: () => items };
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

describe('#413 Manage › Materials', () => {
  it('says there is no shelf without a house service', () => {
    useToolRegistryStore.setState({ status: 'absent' });
    render(<MaterialsScope />);
    expect(screen.getByTestId('manage-materials-absent')).toBeTruthy();
  });

  it('lists the shelf with sizes, layers and what is held or used', async () => {
    fakeShelf();
    render(<MaterialsScope />);
    const plate = await screen.findByTestId('manage-stock-row-stock-plate1');
    expect(plate.textContent).toContain('100.0 × 100.0 × 5.0');
    expect(plate.textContent).toContain('×2, 1 reserved');
    const blank = screen.getByTestId('manage-stock-row-stock-blank1');
    expect(blank.textContent).toContain('white 0.6 / black 2.4');
    expect(blank.textContent).toContain('consumed by job-12');
  });

  it('adds an entry through the form, offering only what the form needs and no sphere', async () => {
    const svc = fakeShelf();
    render(<MaterialsScope />);
    await screen.findByTestId('manage-stock-table');
    fireEvent.click(screen.getByTestId('manage-stock-add'));
    const forms = Array.from((screen.getByTestId('manage-stock-form') as HTMLSelectElement).options).map((o) => o.value);
    expect(forms).not.toContain('sphere');

    fireEvent.change(screen.getByTestId('manage-stock-form'), { target: { value: 'rod' } });
    expect(screen.queryByTestId('manage-stock-size-width')).toBeNull();
    expect(screen.queryByTestId('manage-stock-layer-add')).toBeNull();
    // Save is off, and says why, until the size is complete.
    expect((screen.getByTestId('manage-stock-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('manage-stock-size-diameter'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('manage-stock-size-length'), { target: { value: '120' } });
    fireEvent.change(screen.getByTestId('manage-stock-material'), { target: { value: 'acrylic' } });
    expect((screen.getByTestId('manage-stock-conductive') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId('manage-stock-save'));

    await waitFor(() => expect(svc.sent.some((s) => s.method === 'POST')).toBe(true));
    const posted = svc.sent.find((s) => s.method === 'POST')!.body as Record<string, unknown>;
    expect(posted).toMatchObject({ material: 'acrylic', form: 'rod', size: { diameter: 10, length: 120 }, conductive: false });
    await waitFor(() => expect(svc.items()).toHaveLength(3));
  });

  it('edits and removes an entry under the shelf’s validator', async () => {
    const svc = fakeShelf();
    render(<MaterialsScope />);
    fireEvent.click(await screen.findByTestId('manage-stock-pick-stock-blank1'));
    fireEvent.change(screen.getByTestId('manage-stock-quantity'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('manage-stock-save'));
    await waitFor(() => expect(svc.sent.some((s) => s.method === 'PATCH')).toBe(true));
    await waitFor(() =>
      expect((svc.items().find((i) => i.id === 'stock-blank1') as { quantity?: number }).quantity).toBe(3),
    );

    // A reserved entry cannot be removed here; an unreserved one can.
    fireEvent.click(screen.getByTestId('manage-stock-pick-stock-plate1'));
    expect((screen.getByTestId('manage-stock-remove') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('manage-stock-pick-stock-blank1'));
    fireEvent.click(screen.getByTestId('manage-stock-remove'));
    await waitFor(() => expect(svc.items().map((i) => i.id)).toEqual(['stock-plate1']));
  });

  it('says it is reading while the first read is in flight, not "empty" or "no service"', () => {
    useToolRegistryStore.setState({ status: 'checking' });
    render(<MaterialsScope />);
    expect(screen.getByTestId('manage-materials-loading')).toBeTruthy();
    expect(screen.queryByTestId('manage-materials-absent')).toBeNull();
  });

  it('refuses to save a draft whose entry changed underneath, until it is reloaded (#413 review)', async () => {
    const svc = fakeShelf();
    render(<MaterialsScope />);
    fireEvent.click(await screen.findByTestId('manage-stock-pick-stock-plate1'));
    // The user starts editing: quantity 2 → 5.
    fireEvent.change(screen.getByTestId('manage-stock-quantity'), { target: { value: '5' } });

    // Meanwhile a job consumes its reservation (another window): 2 → 1, a consumed record.
    await act(async () => {
      expect(await useStockStore.getState().consume('stock-plate1', 'job-1')).toBe(true);
    });

    // Save is refused: the draft's quantity would sit beside the new consumed log.
    expect(screen.getByTestId('manage-stock-problem').textContent).toContain('changed since you opened it');
    expect((screen.getByTestId('manage-stock-save') as HTMLButtonElement).disabled).toBe(true);
    const patches = svc.sent.filter((s) => s.method === 'PATCH').length;

    // Reloading takes the current entry; the old count is gone from the form.
    fireEvent.click(screen.getByTestId('manage-stock-reload'));
    expect((screen.getByTestId('manage-stock-quantity') as HTMLInputElement).value).toBe('1');
    expect((screen.getByTestId('manage-stock-save') as HTMLButtonElement).disabled).toBe(false);
    expect(svc.sent.filter((s) => s.method === 'PATCH').length).toBe(patches);
  });

  it('refills an untouched draft when its entry changes', async () => {
    fakeShelf();
    render(<MaterialsScope />);
    fireEvent.click(await screen.findByTestId('manage-stock-pick-stock-plate1'));
    await act(async () => {
      await useStockStore.getState().consume('stock-plate1', 'job-1');
    });
    await waitFor(() => expect((screen.getByTestId('manage-stock-quantity') as HTMLInputElement).value).toBe('1'));
    expect(screen.queryByTestId('manage-stock-reload')).toBeNull();
  });
});
