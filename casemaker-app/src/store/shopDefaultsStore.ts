/**
 * The shop's defaults as this window holds them (`platform/defaultsClient.ts`): read once the house
 * service answers, written one key at a time under the section's `ETag`. A consumer reads a value
 * with {@link useShopDefault} / {@link shopDefault}, which falls back — labelled — only when there is
 * no location to read.
 */

import { create } from 'zustand';
import {
  houseDefaults,
  housePutDefault,
  houseResetDefault,
  readDefault,
  type ReadDefault,
  type ShopDefault,
  type ShopDefaults,
} from '@/platform/defaultsClient';
import { setConsoleDefaultsSource } from '@/platform/machineConsole';

export interface ShopDefaultsState {
  status: 'unknown' | 'present' | 'absent' | 'error';
  defaults: ShopDefaults | null;
  etag: string | null;
  reason: string | null;
  refresh: () => Promise<void>;
  /** Set one key; `false` with `reason` set when refused. A stale guard re-reads. */
  set: (key: string, value: ShopDefault) => Promise<boolean>;
  reset: (key: string) => Promise<boolean>;
}

export const useShopDefaultsStore = create<ShopDefaultsState>((set, get) => {
  async function write(work: () => ReturnType<typeof housePutDefault>): Promise<boolean> {
    const res = await work();
    if (res.kind === 'ok') {
      await get().refresh();
      return true;
    }
    set({ reason: res.kind === 'refused' ? res.message : res.kind === 'absent' ? res.reason : res.detail });
    if (res.kind === 'refused' && (res.status === 412 || res.status === 428)) await get().refresh();
    return false;
  }
  return {
    status: 'unknown',
    defaults: null,
    etag: null,
    reason: null,
    refresh: async () => {
      const res = await houseDefaults();
      if (res.kind === 'ok') set({ status: 'present', defaults: res.defaults, etag: res.etag, reason: null });
      else
        set({
          status: res.kind === 'absent' ? 'absent' : 'error',
          defaults: null,
          etag: null,
          reason: res.kind === 'absent' ? res.reason : res.detail,
        });
    },
    set: (key, value) => write(() => housePutDefault(key, value, get().etag)),
    reset: (key) => write(() => houseResetDefault(key, get().etag)),
  };
});

// #449 — every console the app opens reads its reply window from these defaults, at each line.
setConsoleDefaultsSource(() => useShopDefaultsStore.getState().defaults);

/** The number for `key` right now: the location's, or the labelled fallback with no location. */
export function shopDefault(key: string): ReadDefault {
  return readDefault(useShopDefaultsStore.getState().defaults, key);
}

/** {@link shopDefault} as a hook. */
export function useShopDefault(key: string): ReadDefault {
  const defaults = useShopDefaultsStore((s) => s.defaults);
  return readDefault(defaults, key);
}

/** Test seam. */
export function resetShopDefaultsStore(): void {
  useShopDefaultsStore.setState({ status: 'unknown', defaults: null, etag: null, reason: null });
}
