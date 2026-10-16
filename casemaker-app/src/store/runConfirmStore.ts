/**
 * "I am at the machine", asked ONCE PER JOB (#423, decision Q17) and remembered for that job on that
 * machine for the rest of the session. It covers the machine moving; it does NOT cover a step the
 * operator must do by hand (a bit change, the probe in or out, a remount) — each of those still asks
 * for its own "done". Not persisted: a confirmation is about the person being there now.
 */

import { create } from 'zustand';

export interface RunConfirmState {
  confirmed: ReadonlySet<string>;
  confirm: (key: string) => void;
  isConfirmed: (key: string) => boolean;
}

/** One PROGRAM (by the hash of what was uploaded) on one machine — a re-generated program asks again. */
export function runKey(target: { host: string; port: number }, programHash: string): string {
  return `${target.host}:${target.port}|${programHash}`;
}

export const useRunConfirmStore = create<RunConfirmState>((set, get) => ({
  confirmed: new Set(),
  confirm: (key) => set({ confirmed: new Set([...get().confirmed, key]) }),
  isConfirmed: (key) => get().confirmed.has(key),
}));

export function resetRunConfirmStore(): void {
  useRunConfirmStore.setState({ confirmed: new Set() });
}
