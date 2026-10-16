/**
 * The stock shelf as this window holds it (#413), and the three things a job does to it.
 *
 * READS AND WRITES, ONE STORE. The shelf is small and edited from one screen (Manage › Materials), so
 * unlike the tools — whose reads and writes are split across `toolRegistryStore` and `houseStore` —
 * one store holds the list, its validator and the notice of the last write. Every write re-reads,
 * and a stale guard (#321) re-reads too, so the next attempt carries the current `ETag`.
 *
 * RESERVE, CONSUME, RELEASE (§3.1): a job in Cut mode RESERVES its stock, a finished run CONSUMES it,
 * and a job that is abandoned RELEASES it. Each is a PURE function from an entry to the next entry
 * (or the sentence it is refused with), so the rule is testable without a service, plus a store
 * action that writes the result through the guarded PATCH. No job screen calls them yet: #419 and
 * #414 will, with the job's own id.
 *
 * NO SERVICE, NO SHELF. The hosted web build has no house service; `status` stays `absent` there and
 * Manage › Materials says so.
 */

import { create } from 'zustand';
import { newId } from '@/utils/id';
import {
  houseAddStock,
  houseRemoveStock,
  houseReplaceStock,
  houseStock,
  type StockItem,
  type UnreadableStock,
} from '@/platform/stockClient';
import type { HouseWrite } from '@/platform/houseClient';

export type StockStatus = 'unknown' | 'present' | 'absent' | 'error';

export interface StockNotice {
  kind: 'ok' | 'refused' | 'error';
  text: string;
}

export interface StockState {
  status: StockStatus;
  items: StockItem[];
  unreadable: UnreadableStock[];
  etag: string | null;
  reason: string | null;
  busy: boolean;
  notice: StockNotice | null;
  refresh: () => Promise<void>;
  add: (item: StockItem) => Promise<boolean>;
  replace: (item: StockItem) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  /** Hold `quantity` of an entry for a job (Cut mode). */
  reserve: (id: string, jobId: string, quantity: number) => Promise<boolean>;
  /** A finished run: take the job's reservation off the shelf for good. */
  consume: (id: string, jobId: string) => Promise<boolean>;
  /** An abandoned job: give its reservation back. */
  release: (id: string, jobId: string) => Promise<boolean>;
  dismissNotice: () => void;
}

/** What a rule concluded: the next entry, or why not. */
export type StockStep = { ok: true; item: StockItem } | { ok: false; reason: string };

/** How many of an entry are free: on the shelf and not held for a job. */
export function available(item: StockItem): number {
  return item.quantity - item.reservations.reduce((a, r) => a + r.quantity, 0);
}

/**
 * Reserve `quantity` of `item` for `jobId`. A job holds ONE reservation per entry: reserving again
 * replaces its count (a job that now needs two plates, not one), judged against what the OTHER jobs
 * hold. An entry at 0 is refused with the job that used it last — "consumed by job 12" (§5.1).
 */
export function reserveStock(item: StockItem, jobId: string, quantity: number, at: string): StockStep {
  if (!Number.isInteger(quantity) || quantity <= 0) return { ok: false, reason: 'reserve at least one' };
  if (item.quantity === 0) {
    const last = item.consumed[item.consumed.length - 1];
    return { ok: false, reason: last ? `none left — consumed by ${last.jobId}` : 'none left on the shelf' };
  }
  const others = item.reservations.filter((r) => r.jobId !== jobId);
  const free = item.quantity - others.reduce((a, r) => a + r.quantity, 0);
  if (quantity > free) {
    return { ok: false, reason: `only ${free} free — ${item.quantity - free} held for other jobs` };
  }
  return { ok: true, item: { ...item, reservations: [...others, { jobId, quantity, at }] } };
}

/** Consume `jobId`'s reservation: the count comes off the shelf and goes into the `consumed` log. */
export function consumeStock(item: StockItem, jobId: string, at: string): StockStep {
  const held = item.reservations.find((r) => r.jobId === jobId);
  if (!held) return { ok: false, reason: `${jobId} holds no reservation on this stock` };
  return {
    ok: true,
    item: {
      ...item,
      quantity: item.quantity - held.quantity,
      reservations: item.reservations.filter((r) => r.jobId !== jobId),
      consumed: [...item.consumed, { jobId, quantity: held.quantity, at }],
    },
  };
}

/** Release `jobId`'s reservation, leaving the count on the shelf. */
export function releaseStock(item: StockItem, jobId: string): StockStep {
  if (!item.reservations.some((r) => r.jobId === jobId)) {
    return { ok: false, reason: `${jobId} holds no reservation on this stock` };
  }
  return { ok: true, item: { ...item, reservations: item.reservations.filter((r) => r.jobId !== jobId) } };
}

/** A fresh id for a new entry. */
export function newStockId(): string {
  return newId('stock');
}

function sentence(res: Exclude<HouseWrite, { kind: 'ok' }>): StockNotice {
  if (res.kind === 'refused') return { kind: 'refused', text: res.message };
  return { kind: 'error', text: res.kind === 'absent' ? res.reason : res.detail };
}

export const useStockStore = create<StockState>((set, get) => {
  /** One write: run it, re-read on success or on a stale guard, and say what happened. */
  async function write(work: () => Promise<HouseWrite>, done: string): Promise<boolean> {
    if (get().busy) {
      // Said, not silent (#413 review): a click that did nothing must say why.
      set({ notice: { kind: 'refused', text: 'another change to the shelf is still being saved — try again in a moment' } });
      return false;
    }
    set({ busy: true, notice: null });
    try {
      const res = await work();
      if (res.kind === 'ok') {
        set({ notice: { kind: 'ok', text: done } });
        await get().refresh();
        return true;
      }
      set({ notice: sentence(res) });
      if (res.kind === 'refused' && (res.status === 412 || res.status === 428)) await get().refresh();
      return false;
    } finally {
      set({ busy: false });
    }
  }

  /** A rule applied to one entry, then written. */
  async function step(id: string, rule: (item: StockItem) => StockStep, done: string): Promise<boolean> {
    const item = get().items.find((i) => i.id === id);
    if (!item) {
      set({ notice: { kind: 'refused', text: `${id} is not on the shelf` } });
      return false;
    }
    const next = rule(item);
    if (!next.ok) {
      set({ notice: { kind: 'refused', text: next.reason } });
      return false;
    }
    return write(() => houseReplaceStock(next.item, get().etag), done);
  }

  return {
    status: 'unknown',
    items: [],
    unreadable: [],
    etag: null,
    reason: null,
    busy: false,
    notice: null,

    refresh: async () => {
      const res = await houseStock();
      if (res.kind === 'ok') {
        set({ status: 'present', items: res.items, unreadable: res.unreadable, etag: res.etag, reason: null });
      } else {
        set({
          status: res.kind === 'absent' ? 'absent' : 'error',
          items: [],
          unreadable: [],
          etag: null,
          reason: res.kind === 'absent' ? res.reason : res.detail,
        });
      }
    },

    add: (item) => write(() => houseAddStock(item), 'Put on the shelf.'),
    replace: (item) => write(() => houseReplaceStock(item, get().etag), 'Saved.'),
    remove: (id) => write(() => houseRemoveStock(id, get().etag), 'Taken off the shelf.'),
    reserve: (id, jobId, quantity) =>
      step(id, (i) => reserveStock(i, jobId, quantity, new Date().toISOString()), `Reserved for ${jobId}.`),
    consume: (id, jobId) => step(id, (i) => consumeStock(i, jobId, new Date().toISOString()), `Used by ${jobId}.`),
    release: (id, jobId) => step(id, (i) => releaseStock(i, jobId), `Released from ${jobId}.`),
    dismissNotice: () => set({ notice: null }),
  };
});

/** Test seam. */
export function resetStockStore(): void {
  useStockStore.setState({
    status: 'unknown',
    items: [],
    unreadable: [],
    etag: null,
    reason: null,
    busy: false,
    notice: null,
  });
}
