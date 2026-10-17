// @vitest-environment jsdom
// The stock shelf (#413): the entry schema both sides agree on, the reserve / consume / release
// rules a job will call (#419, #414), and the store's guarded writes against a fake service.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import { SPHERE_REFUSAL, StockItemSchema, stockProblem, type StockItem } from '@/platform/stockClient';
import {
  available,
  consumeStock,
  releaseStock,
  reserveStock,
  resetStockStore,
  useStockStore,
} from '@/store/stockStore';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELF = (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { stock: unknown[] })
  .stock;

const PLATE: StockItem = StockItemSchema.parse(SHELF[0]);
const AT = '2026-10-15T12:00:00.000Z';

describe('the shelf entry (#413), against the shared fixture', () => {
  it('parses every entry the service accepts', () => {
    for (const raw of SHELF) {
      const parsed = StockItemSchema.safeParse(raw);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    const blank = StockItemSchema.parse(SHELF[1]);
    expect(blank.layers.map((l) => l.name)).toEqual(['white', 'black']);
    expect(blank.flatness).toBe('domed');

    // #492 — the purchased laminate: a cap and where it came from, no layers and no print facts.
    const laminate = StockItemSchema.parse(SHELF.find((s) => (s as { id?: string }).id === 'stock-laminate1'));
    expect(laminate.material).toBe('plastic');
    expect(laminate.capMm).toBe(0.075);
    expect(laminate.capSource).toBe('assumed');
    expect(laminate.layers).toEqual([]);
  });

  it('refuses a sphere by name (Q20)', () => {
    expect(stockProblem({ ...PLATE, form: 'sphere' })).toContain(SPHERE_REFUSAL);
  });

  // ONE table, read by this spec and by `house.rs`'s `the_shared_refusal_table_is_refused_here_too`
  // (#413 review): each case patches the fixture's plate, and both sides must refuse it. A case
  // marked `zodOnly` is a rule only the client holds (the material vocabulary).
  const REFUSALS = JSON.parse(readFileSync(join(HERE, 'fixtures', 'stock-refusals.json'), 'utf8')) as Array<{
    why: string;
    patch: Record<string, unknown>;
    zodOnly?: boolean;
  }>;
  it.each(REFUSALS.map((c) => [c.why, c.patch] as const))('refuses %s', (_why, patch) => {
    expect(stockProblem({ ...(SHELF[0] as Record<string, unknown>), ...patch })).not.toBeNull();
  });
});

describe('reserve, consume, release (#413)', () => {
  it('reserves within what is free, one reservation per job', () => {
    // The fixture plate: 2 on the shelf, 1 held for job-1.
    expect(available(PLATE)).toBe(1);
    const r = reserveStock(PLATE, 'job-2', 1, AT);
    expect(r.ok && available(r.item)).toBe(0);
    const over = reserveStock(PLATE, 'job-2', 2, AT);
    expect(over).toEqual({ ok: false, reason: 'only 1 free — 1 held for other jobs' });
    // Reserving again REPLACES the job's own count, judged against the others.
    const again = reserveStock(PLATE, 'job-1', 2, AT);
    expect(again.ok && again.item.reservations).toEqual([{ jobId: 'job-1', quantity: 2, at: AT }]);
  });

  it('consumes a reservation off the shelf and logs it', () => {
    const r = consumeStock(PLATE, 'job-1', AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.quantity).toBe(1);
    expect(r.item.reservations).toEqual([]);
    expect(r.item.consumed).toEqual([{ jobId: 'job-1', quantity: 1, at: AT }]);
    expect(StockItemSchema.safeParse(r.item).success).toBe(true);
    expect(consumeStock(PLATE, 'job-9', AT).ok).toBe(false);
  });

  it('an entry at 0 is refused with the job that used it', () => {
    const blank = StockItemSchema.parse(SHELF[1]);
    expect(reserveStock(blank, 'job-2', 1, AT)).toEqual({ ok: false, reason: 'none left — consumed by job-12' });
  });

  it('releases a reservation and leaves the count', () => {
    const r = releaseStock(PLATE, 'job-1');
    expect(r.ok && [r.item.quantity, r.item.reservations.length]).toEqual([2, 0]);
    expect(releaseStock(PLATE, 'job-9').ok).toBe(false);
  });
});

/** The service's shelf, with a validator that moves on every write, as `house.rs` guards it. */
function fakeShelf(initial: unknown[]) {
  let items = JSON.parse(JSON.stringify(initial)) as Array<{ id: string }>;
  let version = 1;
  const calls: string[] = [];
  const etag = () => `"s-${version}"`;
  const client = {
    call: async (method: string, path: string, body?: unknown, opts?: { ifMatch?: string | null }): Promise<HouseCall> => {
      calls.push(`${method} ${path}`);
      if (method === 'GET' && path === '/stock') return { kind: 'ok', text: JSON.stringify(items), etag: etag() };
      if (method === 'POST' && path === '/stock') {
        items.push(body as { id: string });
        version += 1;
        return { kind: 'ok', text: '' };
      }
      const id = decodeURIComponent(path.replace('/stock/', ''));
      if (opts?.ifMatch !== etag()) return { kind: 'refused', status: 412, message: 'the stock shelf changed since you read it' };
      if (method === 'PATCH') items = items.map((i) => (i.id === id ? (body as { id: string }) : i));
      if (method === 'DELETE') items = items.filter((i) => i.id !== id);
      version += 1;
      return { kind: 'ok', text: '' };
    },
  } as unknown as HouseClient;
  setHouseClientLoader(async () => client);
  return { calls, items: () => items, bump: () => (version += 1) };
}

describe('the shelf store (#413)', () => {
  beforeEach(resetStockStore);
  afterEach(() => setHouseClientLoader(null));

  it('reads, reserves through the guarded PATCH, and consumes', async () => {
    const svc = fakeShelf(SHELF);
    await useStockStore.getState().refresh();
    expect(useStockStore.getState().items).toHaveLength(SHELF.length);

    expect(await useStockStore.getState().reserve('stock-plate1', 'job-2', 1)).toBe(true);
    expect(svc.calls).toContain('PATCH /stock/stock-plate1');
    expect(await useStockStore.getState().consume('stock-plate1', 'job-2')).toBe(true);
    const plate = useStockStore.getState().items.find((i) => i.id === 'stock-plate1')!;
    expect(plate.quantity).toBe(1);
    expect(plate.reservations.map((r) => r.jobId)).toEqual(['job-1']);
  });

  it('a refused rule sends nothing, and a stale guard re-reads', async () => {
    const svc = fakeShelf(SHELF);
    await useStockStore.getState().refresh();
    svc.calls.length = 0;
    expect(await useStockStore.getState().reserve('stock-blank1', 'job-2', 1)).toBe(false);
    expect(useStockStore.getState().notice?.text).toContain('consumed by job-12');
    expect(svc.calls).toEqual([]);

    svc.bump();
    expect(await useStockStore.getState().reserve('stock-plate1', 'job-2', 1)).toBe(false);
    expect(useStockStore.getState().notice?.text).toContain('changed since you read it');
    expect(svc.calls.at(-1)).toBe('GET /stock');
    expect(await useStockStore.getState().reserve('stock-plate1', 'job-2', 1)).toBe(true);
  });

  it('a write while another is in flight says so instead of doing nothing silently', async () => {
    fakeShelf(SHELF);
    await useStockStore.getState().refresh();
    useStockStore.setState({ busy: true });
    expect(await useStockStore.getState().reserve('stock-plate1', 'job-2', 1)).toBe(false);
    expect(useStockStore.getState().notice?.text).toContain('still being saved');
  });

  it('sets aside an entry this build cannot read, and keeps the rest', async () => {
    fakeShelf([...SHELF, { id: 'stock-new', material: 'unobtainium' }]);
    await useStockStore.getState().refresh();
    expect(useStockStore.getState().items).toHaveLength(SHELF.length);
    expect(useStockStore.getState().unreadable.map((u) => u.id)).toEqual(['stock-new']);
  });
});
