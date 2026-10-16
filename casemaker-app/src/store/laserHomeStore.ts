/**
 * Machines a laser point-to-origin left lifted WITHOUT a home (#431 review). The panel unmounts on a tab
 * switch, a viewport selection or a form error (#423's finding), so it may only switch the laser off
 * then — never move the machine nobody pressed anything on. What it owes is recorded here, and the next
 * time the panel or the machine card opens it says "home the machine before the next step", with Home as
 * a button. Kept in this browser's storage so a reload does not forget it.
 */

import { create } from 'zustand';
import { attachConsole } from '@/platform/machineConsole';

const KEY = 'casemaker.laserHome.v1';

export interface PendingHome {
  host: string;
  port: number;
  /** Why it is owed, in a sentence. */
  why: string;
  at: string;
}

function load(): Record<string, PendingHome> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, PendingHome>) : {};
  } catch {
    return {};
  }
}
function save(p: Record<string, PendingHome>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // storage blocked: kept for this window only
  }
}

export const laserHomeKey = (t: { host: string; port: number }) => `${t.host}:${t.port}`;

export interface LaserHomeState {
  pending: Record<string, PendingHome>;
  owe: (t: { host: string; port: number }, why: string) => void;
  clear: (t: { host: string; port: number }) => void;
  /** The operator pressed Home: send `$H`, and clear the debt only when it was answered. */
  home: (t: { host: string; port: number }) => Promise<{ ok: boolean; detail: string }>;
}

export const useLaserHomeStore = create<LaserHomeState>((set, get) => ({
  pending: load(),
  owe: (t, why) => {
    const pending = { ...get().pending, [laserHomeKey(t)]: { host: t.host, port: t.port, why, at: new Date().toISOString() } };
    save(pending);
    set({ pending });
  },
  clear: (t) => {
    const pending = { ...get().pending };
    delete pending[laserHomeKey(t)];
    save(pending);
    set({ pending });
  },
  home: async (t) => {
    const session = attachConsole(t);
    try {
      const r = await session.send('$H');
      if (r.kind !== 'sent') return { ok: false, detail: `Home was not sent: ${r.detail}` };
      get().clear(t);
      return { ok: true, detail: 'Homing.' };
    } finally {
      await session.close();
    }
  },
}));

/** Test seam. */
export function resetLaserHomeStore(): void {
  save({});
  useLaserHomeStore.setState({ pending: {} });
}
