/**
 * #512 — whether the first-run bed wizard is up, and for which machine.
 *
 * A STORE, NOT A PROP, for `machineChangeStore`'s reason: the opener is Manage's Bed block, which
 * the Manage pane replaces rather than covers. The wizard outlives the surface that opened it.
 *
 * SESSION ONLY. The wizard DRAFT is the thing that resumes (kept per machine in `localStorage`,
 * `platform/bedWizard.ts`'s `draftToJson`), not the dialog: reopening is always a deliberate press.
 */

import { create } from 'zustand';

export interface BedWizardState {
  open: boolean;
  machineId: string | null;
  /** Bumped on every open so a new machine's draft remounts the wizard's own state. */
  session: number;
  close: () => void;
}

export const useBedWizardStore = create<BedWizardState>()((set) => ({
  open: false,
  machineId: null,
  session: 0,
  close: () => set({ open: false }),
}));

/** Open the wizard for one machine. Calling it while open restarts it from S0 with that machine. */
export function openBedWizard(machineId: string): void {
  useBedWizardStore.setState((s) => ({ open: true, machineId, session: s.session + 1 }));
}

/** Test seam: closed, with no machine left behind. */
export function resetBedWizard(): void {
  useBedWizardStore.setState({ open: false, machineId: null, session: 0 });
}
