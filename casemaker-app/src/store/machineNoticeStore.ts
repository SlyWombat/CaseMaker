/**
 * The machine reachability transition notice (#555) — the toast/banner the operator sees when the
 * remembered machine goes offline and comes back.
 *
 * Session-scoped and deliberately NOT persisted, like the wizard and the Manage mode: this is
 * something that happened now, not a place the app restores on launch. The heartbeat writes it
 * (`machineHeartbeat.ts`); the pinned machine section (`MachinePin`) renders it. One notice at a
 * time — a drop is the thing that matters, and it holds until the operator dismisses it or the
 * opposite transition replaces it.
 */

import { create } from 'zustand';

/** The two transitions worth surfacing (#555): the drop, and the return. */
export type MachineNoticeKind = 'offline' | 'online';

export interface MachineNotice {
  kind: MachineNoticeKind;
  /** ISO timestamp of the transition, for the banner's "last seen" reading. */
  at: string;
}

interface MachineNoticeState {
  notice: MachineNotice | null;
  /** Write the current notice, replacing the previous one. */
  post: (notice: MachineNotice) => void;
  /** Clear the notice — the operator's ✕. */
  dismiss: () => void;
}

export const useMachineNoticeStore = create<MachineNoticeState>()((set) => ({
  notice: null,
  post: (notice) => set({ notice }),
  dismiss: () => set({ notice: null }),
}));

/** Test seam: clear the notice without touching anything else. */
export function resetMachineNoticeStore(): void {
  useMachineNoticeStore.setState({ notice: null });
}
