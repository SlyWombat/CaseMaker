/**
 * The feeds table as this window holds it (#450 slice 2), on the stock shelf's pattern (#413).
 *
 * READS AND WRITES, ONE STORE. The table is small and edited from one place — Manage › Tools, when
 * #450's editor lands — so one store holds the rows, the table's `ETag` and the notice of the last
 * write. Every write re-reads, and a stale guard (#321) re-reads too, so the next attempt carries
 * the current `ETag`.
 *
 * THE TABLE, NOT THE SELECTION. This store carries rows as the service stores them; `feedsFor`'s
 * lookup by (material, edge, diameter band) is the engine's, not this store's. An overlap is refused
 * by the service's whole-table rule (and by `feedTableProblem` before a write leaves this window),
 * because `entryFor` takes the FIRST matching row.
 *
 * NO SERVICE, NO TABLE. The hosted web build has no house service; `status` stays `absent` there.
 * The compiled `UNMEASURED_FEEDS_TABLE` is the labelled fallback, and resolving one or the other is
 * #450 slice 3's job — this store does not quietly stand the literal in for the service.
 */

import { create } from 'zustand';
import { newId } from '@/utils/id';
import {
  houseAddFeed,
  houseFeedTable,
  houseRemoveFeed,
  houseReplaceFeed,
  type FeedRow,
  type UnreadableFeed,
} from '@/platform/feedClient';
import type { HouseWrite } from '@/platform/houseClient';

export type FeedTableStatus = 'unknown' | 'present' | 'absent' | 'error';

export interface FeedTableNotice {
  kind: 'ok' | 'refused' | 'error';
  text: string;
}

export interface FeedTableState {
  status: FeedTableStatus;
  rows: FeedRow[];
  unreadable: UnreadableFeed[];
  etag: string | null;
  reason: string | null;
  busy: boolean;
  notice: FeedTableNotice | null;
  refresh: () => Promise<void>;
  add: (row: FeedRow) => Promise<boolean>;
  replace: (row: FeedRow) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  dismissNotice: () => void;
}

/** A fresh id for a new row. */
export function newFeedId(): string {
  return newId('feed');
}

function sentence(res: Exclude<HouseWrite, { kind: 'ok' }>): FeedTableNotice {
  if (res.kind === 'refused') return { kind: 'refused', text: res.message };
  return { kind: 'error', text: res.kind === 'absent' ? res.reason : res.detail };
}

export const useFeedTableStore = create<FeedTableState>((set, get) => {
  /** One write: run it, re-read on success or on a stale guard, and say what happened. */
  async function write(work: () => Promise<HouseWrite>, done: string): Promise<boolean> {
    if (get().busy) {
      set({
        notice: {
          kind: 'refused',
          text: 'another change to the feeds table is still being saved — try again in a moment',
        },
      });
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

  return {
    status: 'unknown',
    rows: [],
    unreadable: [],
    etag: null,
    reason: null,
    busy: false,
    notice: null,

    refresh: async () => {
      const res = await houseFeedTable();
      if (res.kind === 'ok') {
        set({ status: 'present', rows: res.rows, unreadable: res.unreadable, etag: res.etag, reason: null });
      } else {
        set({
          status: res.kind === 'absent' ? 'absent' : 'error',
          rows: [],
          unreadable: [],
          etag: null,
          reason: res.kind === 'absent' ? res.reason : res.detail,
        });
      }
    },

    add: (row) => write(() => houseAddFeed(row), 'Added to the feeds table.'),
    replace: (row) => write(() => houseReplaceFeed(row, get().etag), 'Saved.'),
    remove: (id) => write(() => houseRemoveFeed(id, get().etag), 'Taken out of the feeds table.'),
    dismissNotice: () => set({ notice: null }),
  };
});

/** Test seam. */
export function resetFeedTableStore(): void {
  useFeedTableStore.setState({
    status: 'unknown',
    rows: [],
    unreadable: [],
    etag: null,
    reason: null,
    busy: false,
    notice: null,
  });
}
